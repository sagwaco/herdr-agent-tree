// The tree pane. Reads Herdr's snapshot plus the lineage log, renders a tree of
// agents and the subagents they launched, and lets the user jump to a pane.
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  absorbSnapshot, applyDeclared, attribute, buildModel, call, flattenTree, keyOf, lastFocusKey,
  readHierarchy, readOverrides, readRecords, siblingKeys, titleOf,
} from './lib.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const REVERSE = '\x1b[7m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';

const STATUS = {
  working: [YELLOW, 'working'],
  blocked: [RED, 'blocked'],
  idle: [GREEN, 'idle'],
  done: [CYAN, 'done'],
  unknown: [GRAY, 'unknown'],
};

const cellWidth = (character) => character.codePointAt(0) > 0x7e ? 2 : 1;

export function sanitize(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

// Clip to terminal cells while passing ANSI escapes through untouched.
export function clip(value, width) {
  let result = '';
  let used = 0;
  let inEscape = false;
  for (const character of String(value ?? '')) {
    if (inEscape) {
      result += character;
      if ((character >= '@' && character <= '~') || (character >= ' ' && character <= '/')) inEscape = false;
      continue;
    }
    if (character === '\x1b') {
      inEscape = true;
      result += character;
      continue;
    }
    const cells = cellWidth(character);
    if (used + cells > width) break;
    result += character;
    used += cells;
  }
  return result;
}

export function renderTree(tree, { width = 80, height = 24, selected = 0, status = '' } = {}) {
  const { rows, agents, roots } = tree;
  const lines = [];
  const header = `Agent tree — ${agents} agent${agents === 1 ? '' : 's'}, ${roots} root${roots === 1 ? '' : 's'}`;
  lines.push(clip(`${BOLD}${header}${RESET}`, width));
  const bodyHeight = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), Math.max(0, rows.length - bodyHeight)));
  const visible = rows.slice(start, start + bodyHeight);
  if (!rows.length) lines.push(`${DIM}No agents running.${RESET}`);
  for (let i = 0; i < visible.length; i += 1) {
    const { node, depth, last } = visible[i];
    const branch = depth === 0 ? '' : `${'  '.repeat(depth - 1)}${last ? '└─ ' : '├─ '}`;
    const [color, word] = STATUS[node.status] ?? STATUS.unknown;
    const row = `${branch}${CYAN}${sanitize(node.agent)}${RESET}  ${sanitize(node.title)}  ` +
      `${DIM}[${sanitize(node.tabLabel)}]${RESET}  ${color}${word}${RESET}`;
    const index = start + i;
    lines.push(index === selected ? `${REVERSE}${clip(row, width)}${RESET}` : clip(row, width));
  }
  while (lines.length < height - 2) lines.push('');
  const current = rows[selected];
  let detail = '';
  if (current) {
    const node = current.node;
    const parent = node.parent ? tree.byKey?.get(node.parent) : null;
    const parts = [`${sanitize(node.agent)} ${sanitize(node.title)}`, sanitize(node.pane)];
    if (parent) parts.push(`↳ ${sanitize(parent.agent)} ${sanitize(parent.title)}${node.why ? ` (${sanitize(node.why)})` : ''}`);
    detail = parts.join(' · ');
  }
  if (status) detail = `${detail ? `${detail} · ` : ''}${sanitize(status)}`;
  lines.push(clip(`${DIM}${detail}${RESET}`, width));
  lines.push(clip(`${DIM}r refresh · ↑/↓ move · enter focus · q close${RESET}`, width));
  return lines.slice(0, height).map((line) => clip(line, width)).join('\r\n');
}

export function plainTree(tree) {
  const { rows } = tree;
  if (!rows.length) return 'No agents running.\n';
  return rows.map(({ node, depth, last }) => {
    const branch = depth === 0 ? '' : `${'  '.repeat(depth - 1)}${last ? '└─ ' : '├─ '}`;
    const parent = node.parent ? ` <- ${sanitize(node.parent)} (${sanitize(node.why)})` : '';
    return `${branch}${sanitize(node.agent)}  ${sanitize(node.title)}  [${sanitize(node.tabLabel)}]  ${node.status}  ${sanitize(node.pane)}${parent}\n`;
  }).join('');
}

export async function loadTree(callFn, stateDir, configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir) {
  const snapshot = (await callFn('session.snapshot')).snapshot;
  const model = buildModel(await readRecords(stateDir));
  const overrides = await readOverrides(stateDir);
  const declared = await readHierarchy(configDir);
  const now = Date.now();
  for (const agent of snapshot.agents ?? []) {
    const key = keyOf(agent);
    const previous = model.seen.get(key);
    if (previous) model.seen.set(key, { ...previous, status: agent.agent_status ?? previous.status, title: titleOf(agent) });
  }
  const { added } = await absorbSnapshot(model, snapshot, callFn, now);
  const hints = (child) => {
    const fresh = now - (child.start ?? now) <= 2 * 60_000;
    return {
      siblings: fresh ? siblingKeys(snapshot, child) : new Set(),
      focusKey: fresh ? lastFocusKey(model, child.pane, now) : null,
    };
  };
  attribute(model, now, added.length ? added : null, overrides, hints);
  attribute(model, now, null, overrides, hints);
  applyDeclared(model, declared);
  const tree = flattenTree(snapshot, model);
  tree.byKey = new Map(tree.rows.map(({ node }) => [node.key, node]));
  return tree;
}

export async function main({
  input = process.stdin, output = process.stdout,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  socketPath = process.env.HERDR_SOCKET_PATH,
  load = null,
} = {}) {
  if (!stateDir) throw new Error('HERDR_PLUGIN_STATE_DIR is not set.');
  if (!socketPath) throw new Error('HERDR_SOCKET_PATH is not set.');
  const callFn = call(socketPath);
  const refreshTree = load ?? (() => loadTree(callFn, stateDir));

  if (!input.isTTY || !output.isTTY) {
    output.write(plainTree(await refreshTree()));
    return;
  }

  let tree = { rows: [], roots: 0, agents: 0, byKey: new Map() };
  let state = { selected: 0, status: '', error: '' };
  let loading = false;
  let queued = false;
  let finished = false;
  let timer;
  let lastScreen;
  let cleaned = false;
  const wasRaw = Boolean(input.isRaw);
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };
  const handlers = new Map();
  let finish;
  let draw = () => {};

  async function refresh() {
    if (finished) return;
    if (loading) { queued = true; return; }
    loading = true;
    try {
      const next = await refreshTree();
      if (finished) return;
      tree = next;
      if (state.selected >= tree.rows.length) state.selected = Math.max(0, tree.rows.length - 1);
      state = { ...state, error: '' };
    } catch (error) {
      if (!finished) state = { ...state, error: sanitize(error?.message ?? error) };
    } finally {
      loading = false;
    }
    if (finished) return;
    draw();
    if (queued) { queued = false; await refresh(); }
  }

  async function focusSelected() {
    const row = tree.rows[state.selected];
    if (!row) return;
    try {
      await callFn('agent.focus', { target: row.node.pane });
      if (!finished) state = { ...state, status: `focused ${row.node.pane}` };
    } catch {
      if (!finished) state = { ...state, status: 'focus unavailable' };
    }
    draw();
  }

  const onKey = (text, key = {}) => {
    const name = key.name ?? text;
    if (name === 'q' || (key.ctrl && name === 'c')) return finish();
    if (name === 'r') return void refresh();
    if (name === 'return' || name === 'enter' || name === 'f') return void focusSelected();
    if (name === 'j' || name === 'down') state = { ...state, selected: Math.min(state.selected + 1, Math.max(0, tree.rows.length - 1)), status: '' };
    else if (name === 'k' || name === 'up') state = { ...state, selected: Math.max(0, state.selected - 1), status: '' };
    else return;
    draw();
  };

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    finished = true;
    clearInterval(timer);
    input.off('keypress', onKey);
    output.off('resize', onResize);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try { input.setRawMode(wasRaw); } catch { /* The terminal can close first. */ }
    try { output.write('\x1b[?25h\x1b[?1049l'); } catch { /* The pane can close first. */ }
    input.pause();
  }

  function onResize() { try { draw(); } catch (error) { finish(error); } }

  draw = () => {
    const screen = renderTree(tree, {
      width: output.columns || 80,
      height: output.rows || 24,
      selected: state.selected,
      status: state.error ? `error: ${state.error}` : state.status,
    });
    if (screen !== lastScreen) {
      output.write('\x1b[H\x1b[2J' + screen);
      lastScreen = screen;
    }
  };

  await new Promise((resolve, reject) => {
    finish = (error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error); else resolve();
    };
    process.on('exit', cleanup);
    for (const [signal, code] of Object.entries(signals)) {
      const handler = () => { process.exitCode = code; finish(); };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.on('error', (error) => finish(error));
    output.on('error', (error) => finish(error));
    output.on('resize', onResize);
    input.setRawMode(true);
    input.resume();
    output.write('\x1b[?1049h\x1b[?25l');
    timer = setInterval(() => void refresh(), 2_000);
    void refresh();
  });
  cleanup();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Agent tree unavailable: ${sanitize(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
