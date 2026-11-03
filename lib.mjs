// Shared plumbing: Herdr socket RPC, the lineage log and the parent-inference
// rules used by both the event hook and the tree pane.
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';

export const PLUGIN_ID = 'herdr-agent-tree';
export const ENTRYPOINT = 'tree';

const LOG_FILE = 'lineage.jsonl';
const OVERRIDES_FILE = 'overrides.json';
export const HIERARCHY_FILE = 'hierarchy.json';
// A parent candidate must have been active within this window.
const WINDOW_MS = 15 * 60_000;
const MIN_SCORE = 55;
const MAX_RESPONSE = 4_000_000;

// Herdr's stable handle for an agent is its pane; the terminal id survives
// agent restarts and is what the lineage log keys on.
export const keyOf = (agent) => agent?.terminal_id || agent?.pane_id || '?';

export const titleOf = (agent) =>
  agent?.name || agent?.title || agent?.terminal_title_stripped || agent?.terminal_title ||
  (agent?.cwd ? agent.cwd.split('/').filter(Boolean).pop() : '') || 'agent';

export function rpc(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `agent-tree:${process.pid}:${Math.random().toString(16).slice(2)}`;
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('herdr-timeout')), 8_000);
    function finish(error, result) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.setEncoding('utf8');
    socket.on('error', () => finish(new Error('herdr-unavailable')));
    socket.on('end', () => finish(new Error('herdr-disconnected')));
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE) return finish(new Error('herdr-response-too-large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id || response.error || !response.result) throw new Error();
        finish(null, response.result);
      } catch { finish(new Error('herdr-invalid-response')); }
    });
  });
}

export const call = (socketPath) => (method, params) => rpc(socketPath, method, params);

export async function readRecords(stateDir) {
  try {
    const text = await readFile(join(stateDir, LOG_FILE), 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch { /* A torn line from a crash is skipped. */ }
    }
    return records;
  } catch { return []; }
}

export async function appendRecords(stateDir, records) {
  if (!records.length) return;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // One append per event keeps concurrent hook processes from clobbering each
  // other: O_APPEND writes under the line size are atomic on POSIX.
  await appendFile(stateDir + '/' + LOG_FILE, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
}

export async function readOverrides(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, OVERRIDES_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

export function seenFromAgent(agent, now, start) {
  return {
    k: 'seen',
    t: now,
    key: keyOf(agent),
    pane: agent.pane_id,
    agent: agent.agent ?? 'agent',
    title: titleOf(agent),
    tab: agent.tab_id ?? null,
    ws: agent.workspace_id ?? null,
    cwd: agent.foreground_cwd ?? agent.cwd ?? null,
    status: agent.agent_status ?? 'unknown',
    firstSeen: start ?? now,
    start: start ?? now,
    // For bootstrap records "last activity" is the launch time; later stat
    // records move it forward. That keeps long-running agents from looking
    // freshly active when the plugin starts mid-session.
    lastSeen: start ?? now,
    gone: false,
  };
}

// The tree an orchestrator declared. Lives in the plugin config dir so agents
// can find it with `herdr plugin config-dir herdr-agent-tree`.
export async function readHierarchy(dir) {
  try {
    return normalizeHierarchy(JSON.parse(await readFile(join(dir, HIERARCHY_FILE), 'utf8')));
  } catch { return { edges: {}, roots: [] }; }
}

// Accepts both the canonical { edges, roots } document and a bare
// child-to-parent map, so a hand-written file can stay one line per edge.
export function normalizeHierarchy(parsed) {
  const edges = {};
  const roots = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { edges, roots };
  const raw = parsed.edges && typeof parsed.edges === 'object' ? parsed.edges : parsed;
  for (const [child, value] of Object.entries(raw)) {
    if (!child || child === 'edges' || child === 'roots') continue;
    const parent = typeof value === 'string' ? value : value?.parent;
    if (typeof parent === 'string' && parent) edges[child] = parent;
  }
  if (Array.isArray(parsed.roots)) {
    for (const root of parsed.roots) if (typeof root === 'string' && root) roots.push(root);
  }
  return { edges, roots };
}

// Apply declarations last: a declared edge or root outranks both inference and
// a stale edge already in the log. Undeclared agents keep the inferred parent.
export function applyDeclared(model, declared) {
  if (!declared) return model;
  const { seen, edges } = model;
  for (const id of declared.roots ?? []) {
    const key = resolveKey(seen, id);
    if (key) edges.delete(key);
  }
  for (const [childId, parentId] of Object.entries(declared.edges ?? {})) {
    const child = resolveKey(seen, childId);
    const parent = resolveKey(seen, parentId);
    if (!child || !parent || child === parent || wouldCycle(edges, child, parent)) continue;
    edges.set(child, { parent, why: 'declared', score: 1000 });
  }
  return model;
}

// Reduce the append-only log to the current view of each agent and the edges
// inferred or overridden so far.
export function buildModel(records) {
  const seen = new Map();
  const edges = new Map();
  const focus = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const t = Number.isFinite(r.t) ? r.t : Date.now();
    if (r.k === 'seen' && r.key) {
      const prev = seen.get(r.key);
      seen.set(r.key, {
        ...(prev ?? {}), ...r,
        firstSeen: prev?.firstSeen ?? (Number.isFinite(r.firstSeen) ? r.firstSeen : t),
        // A bootstrap record carries the launch time as its last activity;
        // later stat records move that forward.
        lastSeen: Number.isFinite(r.lastSeen) ? r.lastSeen : t,
        gone: false,
      });
    } else if (r.k === 'stat' && r.key && seen.has(r.key)) {
      seen.set(r.key, { ...seen.get(r.key), ...r, lastSeen: t });
    } else if (r.k === 'gone' && r.key && seen.has(r.key)) {
      seen.set(r.key, { ...seen.get(r.key), gone: true, lastSeen: t });
    } else if (r.k === 'edge' && r.child && r.parent) {
      edges.set(r.child, { parent: r.parent, why: r.why ?? '', score: r.score ?? 0 });
    } else if (r.k === 'focus' && r.pane) {
      focus.push({ t, pane: r.pane });
      if (focus.length > 40) focus.shift();
    }
  }
  return { seen, edges, focus };
}

// An edge must not make a cycle, and a parent must have existed before its
// child. Herdr exposes no launch link, so "before" is process start time when
// known, otherwise the first time the plugin saw the agent.
export function wouldCycle(edges, childKey, parentKey) {
  let key = parentKey;
  const visited = new Set();
  while (key && !visited.has(key)) {
    if (key === childKey) return true;
    visited.add(key);
    key = edges.get(key)?.parent;
  }
  return false;
}

export function overrideFor(overrides, child) {
  for (const id of [child.key, child.pane]) {
    const value = id ? overrides[id] : undefined;
    if (typeof value === 'string') return value;
    if (value && typeof value.parent === 'string') return value.parent;
  }
  return null;
}

// An override may name either a terminal id (the log's key) or a pane id.
function resolveKey(seen, id) {
  if (!id) return null;
  if (seen.has(id)) return id;
  for (const [key, record] of seen) if (record.pane === id && !record.gone) return key;
  return null;
}

export function scoreParent(child, candidate, now, hints = {}) {
  if (!candidate || candidate.gone || candidate.key === child.key) return null;
  const sameTab = Boolean(child.tab && candidate.tab === child.tab);
  const sameWorkspace = Boolean(child.ws && candidate.ws === child.ws);
  const sameCwd = Boolean(child.cwd && candidate.cwd === child.cwd);
  // Herdr splits a pane in two: the new pane is the sibling of the pane the
  // caller launched from. That structural link is the strongest signal.
  const sibling = Boolean(hints.siblings?.has(candidate.key));
  // A focused agent whose pane the launch inherited is the next best signal.
  const focused = Boolean(hints.focusKey && candidate.key === hints.focusKey && sameWorkspace);
  // A subagent is launched from a sibling pane in the same tab or a new tab in
  // the same workspace; the cwd usually follows the parent. Anything else is
  // too weak to claim.
  if (!sameTab && !sameCwd && !focused) return null;
  const childStart = child.start ?? child.firstSeen ?? now;
  const candidateStart = candidate.start ?? candidate.firstSeen ?? 0;
  if (candidateStart > childStart) return null;
  const age = now - (candidate.lastSeen ?? now);
  const recent = age <= 5 * 60_000;
  if (!sameCwd && !recent && !focused && !sibling) return null;
  let score = 0;
  const why = [];
  if (sibling) { score += 200; why.push('sibling pane'); }
  if (focused) { score += 100; why.push('focused when launched'); }
  if (sameTab) { score += 60; why.push('same tab'); }
  else if (sameWorkspace) { score += 25; why.push('same workspace'); }
  if (sameCwd) { score += 25; why.push('same cwd'); }
  if (candidate.status === 'working') { score += 8; why.push('working'); }
  else if (candidate.status === 'blocked') { score += 5; why.push('blocked'); }
  if (age <= 60_000) { score += 20; why.push('active'); }
  else if (age <= 5 * 60_000) score += 10;
  else score += 2;
  // A subagent is launched by an agent that started shortly before it. This is
  // the tie-breaker when several agents share the workspace and cwd.
  const gap = Math.max(0, childStart - candidateStart);
  const proximity = Math.round(Math.max(0, 25 * (1 - gap / WINDOW_MS)));
  if (proximity >= 12) { score += proximity; why.push('launched just before'); }
  else score += proximity;
  if (score < MIN_SCORE) return null;
  return { score, why: why.join(', ') };
}

// Assign parents oldest-first so an agent that launched a chain is linked
// before its own child is considered. Returns only the new edges.
export function attribute(model, now, keys = null, overrides = {}, hints = {}) {
  const { seen, edges } = model;
  const targets = (keys ?? [...seen.keys()])
    .filter((key) => seen.has(key) && !edges.has(key))
    .sort((a, b) => {
      const sa = seen.get(a).start ?? seen.get(a).firstSeen ?? 0;
      const sb = seen.get(b).start ?? seen.get(b).firstSeen ?? 0;
      return sa - sb;
    });
  const assigned = [];
  for (const key of targets) {
    const child = seen.get(key);
    let pick = null;
    const override = resolveKey(seen, overrideFor(overrides, child));
    if (override) {
      const parent = seen.get(override);
      if (parent && parent.key !== child.key && !parent.gone && !wouldCycle(edges, key, parent.key)) {
        pick = { parent: parent.key, why: 'override', score: 999 };
      }
    }
    if (!pick) {
      let best = null;
      const hint = typeof hints === 'function' ? hints(child) : hints;
      for (const candidate of seen.values()) {
        const scored = scoreParent(child, candidate, now, hint);
        if (!scored) continue;
        if (wouldCycle(edges, key, candidate.key)) continue;
        if (!best || scored.score > best.score ||
          (scored.score === best.score && (candidate.lastSeen ?? 0) > (seen.get(best.parent)?.lastSeen ?? 0))) {
          best = { parent: candidate.key, ...scored };
        }
      }
      pick = best;
    }
    if (pick) {
      edges.set(key, { parent: pick.parent, why: pick.why, score: pick.score });
      assigned.push({ k: 'edge', t: now, child: key, parent: pick.parent, why: pick.why, score: pick.score });
    }
  }
  return assigned;
}

export function parseEtime(text) {
  if (!text) return null;
  let rest = String(text).trim();
  let days = 0;
  const dash = rest.indexOf('-');
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
    if (!Number.isFinite(days)) return null;
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86400 + seconds;
}

// Start times for the agent process in each pane. Used to order bootstrap
// candidates and to keep a parent older than its child. The agent process is
// the foreground process-group leader when Herdr reports one.
export async function startsFor(callFn, agents, now = Date.now()) {
  const starts = new Map();
  const pids = new Map();
  for (const agent of agents) {
    try {
      const info = (await callFn('pane.process_info', { pane_id: agent.pane_id })).process_info;
      const leader = info?.foreground_process_group_id ?? info?.shell_pid;
      const list = info?.foreground_processes ?? [];
      const process = list.find((item) => item.pid === leader) ?? list[list.length - 1];
      if (process?.pid) pids.set(keyOf(agent), process.pid);
    } catch { /* Process info is optional; order falls back to detection time. */ }
  }
  const etimes = new Map();
  if (pids.size) {
    try {
      const output = execFileSync('ps', ['-o', 'pid=,etime=', '-p', [...pids.values()].join(',')], {
        encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
        if (match) etimes.set(Number(match[1]), parseEtime(match[2]));
      }
    } catch { /* Fall back to "now" for every agent. */ }
  }
  for (const [key, pid] of pids) {
    const elapsed = etimes.get(pid);
    starts.set(key, elapsed == null ? now : now - elapsed * 1000);
  }
  return starts;
}

// Add agents Herdr knows about but the log has not seen yet. Bootstrap agents
// get their process start time so ordering and parent choice stay sensible.
export async function absorbSnapshot(model, snapshot, callFn, now = Date.now()) {
  const fresh = (snapshot.agents ?? []).filter((agent) => !model.seen.has(keyOf(agent)));
  if (!fresh.length) return { added: [], starts: new Map() };
  const starts = await startsFor(callFn, fresh, now);
  for (const agent of fresh) {
    const key = keyOf(agent);
    const record = seenFromAgent(agent, now, starts.get(key));
    model.seen.set(key, { ...record, gone: false });
  }
  return { added: fresh.map(keyOf), starts };
}

export function flattenTree(snapshot, model) {
  const workspaceOrder = new Map((snapshot.workspaces ?? []).map((w) => [w.workspace_id, w.number ?? 0]));
  const tabOrder = new Map((snapshot.tabs ?? []).map((t) => [t.tab_id, t.number ?? 0]));
  const tabLabel = new Map((snapshot.tabs ?? []).map((t) => [t.tab_id, t.label ?? t.tab_id]));
  const wsLabel = new Map((snapshot.workspaces ?? []).map((w) => [w.workspace_id, w.label ?? w.workspace_id]));
  const nodes = new Map();
  for (const agent of snapshot.agents ?? []) {
    const key = keyOf(agent);
    nodes.set(key, {
      key,
      agent: agent.agent ?? 'agent',
      title: titleOf(agent),
      pane: agent.pane_id,
      tab: agent.tab_id,
      tabLabel: tabLabel.get(agent.tab_id) ?? agent.tab_id ?? '',
      ws: agent.workspace_id,
      wsLabel: wsLabel.get(agent.workspace_id) ?? agent.workspace_id ?? '',
      status: agent.agent_status ?? 'unknown',
      parent: null,
      why: '',
      children: [],
    });
  }
  for (const node of nodes.values()) {
    const edge = model.edges.get(node.key);
    if (edge && edge.parent !== node.key && nodes.has(edge.parent)) {
      node.parent = edge.parent;
      // Say which side chose the parent: a declaration the orchestrator made,
      // or the inference rules. A miss shows up as "inferred".
      node.why = edge.why === 'declared' || edge.why === 'override'
        ? edge.why
        : `inferred: ${edge.why || 'rules'}`;
    }
  }
  // A stale or hand-edited edge could loop; drop the link instead of hanging.
  for (const node of nodes.values()) {
    const visited = new Set([node.key]);
    let key = node.parent;
    while (key) {
      if (visited.has(key)) { node.parent = null; node.why = 'cycle broken'; break; }
      visited.add(key);
      key = nodes.get(key)?.parent ?? null;
    }
  }
  for (const node of nodes.values()) if (node.parent) nodes.get(node.parent).children.push(node);
  const rank = (node) => (workspaceOrder.get(node.ws) ?? 999) * 10_000 + (tabOrder.get(node.tab) ?? 999) * 100;
  const order = (a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title));
  const rows = [];
  const walk = (node, depth, last) => {
    rows.push({ node, depth, last });
    node.children.sort(order).forEach((child, index, all) => walk(child, depth + 1, index === all.length - 1));
  };
  const roots = [...nodes.values()].filter((node) => !node.parent).sort(order);
  roots.forEach((root, index) => walk(root, 0, index === roots.length - 1));
  return { rows, roots: roots.length, agents: nodes.size };
}

export function keyForPane(model, paneId) {
  let best = null;
  for (const record of model.seen.values()) {
    if (record.pane !== paneId || record.gone) continue;
    if (!best || (record.lastSeen ?? 0) > (best.lastSeen ?? 0)) best = record;
  }
  return best?.key ?? null;
}

export function agentKeyForPane(snapshot, paneId) {
  const agent = (snapshot.agents ?? []).find((item) => item.pane_id === paneId);
  return agent ? keyOf(agent) : null;
}

// Panes that share the child's immediate split node. Herdr splits a pane into
// two, so the pane an agent launched from is normally the only sibling.
export function siblingPanes(snapshot, paneId) {
  const pane = (snapshot.panes ?? []).find((item) => item.pane_id === paneId);
  if (!pane) return [];
  const layout = (snapshot.layouts ?? []).find((item) => item.tab_id === pane.tab_id);
  if (!layout) return [];
  const rects = new Map((layout.panes ?? []).map((item) => [item.pane_id, item.rect]));
  const child = rects.get(paneId);
  if (!child) return [];
  const inside = (outer, inner) => outer && inner &&
    outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
  const area = (rect) => rect.width * rect.height;
  let parent = null;
  for (const split of layout.splits ?? []) {
    if (!inside(split.rect, child)) continue;
    const same = split.rect.x === child.x && split.rect.y === child.y &&
      split.rect.width === child.width && split.rect.height === child.height;
    if (same) continue;
    if (!parent || area(split.rect) < area(parent.rect)) parent = split;
  }
  if (!parent) return [];
  return (layout.panes ?? [])
    .map((item) => item.pane_id)
    .filter((id) => id !== paneId && inside(parent.rect, rects.get(id)));
}

export function siblingKeys(snapshot, child) {
  const keys = new Set();
  for (const paneId of siblingPanes(snapshot, child.pane)) {
    const key = agentKeyForPane(snapshot, paneId);
    if (key) keys.add(key);
  }
  return keys;
}

// The agent focused just before this pane appeared is usually the launcher.
export function lastFocusKey(model, childPaneId, now, maxAge = 120_000) {
  for (let index = model.focus.length - 1; index >= 0; index -= 1) {
    const event = model.focus[index];
    if (event.pane === childPaneId) continue;
    if (now - event.t > maxAge) break;
    const key = keyForPane(model, event.pane);
    if (key) return key;
  }
  return null;
}
