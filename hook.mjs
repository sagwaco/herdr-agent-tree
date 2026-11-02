// Event hook. Herdr starts this per matching event and passes the payload in
// HERDR_PLUGIN_EVENT_JSON. It appends to the lineage log so the tree pane can
// show launch relationships without polling for them.
//
// shortcut: no log rotation; a long-running Herdr with thousands of agent
// events grows lineage.jsonl. Rotate or compact it when it passes a few MB.
import { pathToFileURL } from 'node:url';
import {
  absorbSnapshot, appendRecords, applyDeclared, attribute, buildModel, call, lastFocusKey,
  readHierarchy, readOverrides, readRecords, siblingKeys,
} from './lib.mjs';

const dot = (name) => String(name ?? '').replace(/_/g, '.');

export async function handleEvent({ event, socketPath, stateDir, configDir, now = Date.now() }) {
  const name = dot(event?.event ?? event?.type);
  const data = event?.data ?? event ?? {};
  const callFn = call(socketPath);
  const model = buildModel(await readRecords(stateDir));
  const overrides = await readOverrides(stateDir);
  const declared = await readHierarchy(configDir ?? process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir);
  const writes = [];

  const keyForPane = (paneId) => {
    let best = null;
    for (const record of model.seen.values()) {
      if (record.pane !== paneId || record.gone) continue;
      if (!best || (record.lastSeen ?? 0) > (best.lastSeen ?? 0)) best = record;
    }
    return best?.key ?? null;
  };

  // The snapshot is only needed when the log cannot answer from what it has:
  // a detection, an empty log, or a pane that just became visible.
  const needsSnapshot = name === 'pane.agent.detected' || model.seen.size === 0 ||
    (data.pane_id && !keyForPane(data.pane_id) &&
      name !== 'pane.closed' && name !== 'pane.exited' && name !== 'pane.focused');

  let added = [];
  let snapshot = null;
  if (needsSnapshot) {
    snapshot = (await callFn('session.snapshot')).snapshot;
    ({ added } = await absorbSnapshot(model, snapshot, callFn, now));
  }

  // Assign parents oldest-first; this also fills in agents the hook missed
  // before it was installed or while Herdr was restarting. A sibling pane in
  // the same tab and the pane focused just before the launch both outrank the
  // cwd/activity heuristic.
  // Layout and focus are only meaningful right after a pane appears; for an
  // older agent the geometry or the user's focus has likely moved on.
  const hints = snapshot
    ? (child) => {
      const fresh = now - (child.start ?? now) <= 2 * 60_000;
      return {
        siblings: fresh ? siblingKeys(snapshot, child) : new Set(),
        focusKey: fresh ? lastFocusKey(model, child.pane, now) : null,
      };
    }
    : {};
  writes.push(...attribute(model, now, added.length ? added : null, overrides, hints));
  // A hierarchy an orchestrator declared wins over anything inferred above.
  applyDeclared(model, declared);
  for (const key of added) writes.push(model.seen.get(key));

  if (data.pane_id && (name === 'pane.agent.detected' || name === 'pane.agent.status.changed')) {
    const key = keyForPane(data.pane_id);
    if (key) {
      const record = model.seen.get(key);
      writes.push({
        k: 'stat',
        t: now,
        key,
        status: data.agent_status ?? data.final_status ?? record.status,
        title: data.title ?? record.title,
        lastSeen: now,
      });
    }
  }

  if (name === 'pane.focused' && data.pane_id) {
    writes.push({ k: 'focus', t: now, pane: data.pane_id });
  }

  if (name === 'pane.closed' || name === 'pane.exited') {
    const key = keyForPane(data.pane_id);
    if (key) writes.push({ k: 'gone', t: now, key });
  }

  await appendRecords(stateDir, writes);
  return { event: name, added: added.length, edges: writes.filter((w) => w.k === 'edge').length };
}

async function main() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!raw || !socketPath || !stateDir) return;
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  try {
    await handleEvent({ event, socketPath, stateDir });
  } catch (error) {
    // A failed hook must not block Herdr's event dispatch; the next event retries.
    console.error(`agent-tree hook: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
