import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attribute, buildModel, flattenTree, keyOf, lastFocusKey, parseEtime, scoreParent,
  seenFromAgent, siblingPanes, wouldCycle,
} from '../lib.mjs';

const NOW = 1_800_000_000_000;
const agent = (pane, { terminal = `term_${pane}`, kind = 'claude', tab = 'w1:t1', ws = 'w1', cwd = '/repo', status = 'working' } = {}) => ({
  pane_id: pane, terminal_id: terminal, agent: kind, agent_status: status, tab_id: tab, workspace_id: ws,
  cwd, foreground_cwd: cwd, title: `title ${pane}`,
});

test('parseEtime reads ps elapsed formats', () => {
  assert.equal(parseEtime('05:03'), 303);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('2-01:02:03'), 2 * 86400 + 3723);
  assert.equal(parseEtime('bogus'), null);
});

test('keyOf prefers the terminal id', () => {
  assert.equal(keyOf({ terminal_id: 't1', pane_id: 'w1:p1' }), 't1');
  assert.equal(keyOf({ pane_id: 'w1:p1' }), 'w1:p1');
});

test('same tab plus cwd beats an idle stranger', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 120_000);
  const child = seenFromAgent(agent('w1:p2'), NOW, NOW - 1_000);
  const stranger = seenFromAgent(agent('w1:p3', { cwd: '/other', status: 'idle' }), NOW - 900_000, NOW - 900_000);
  const scored = scoreParent(child, parent, NOW);
  assert.ok(scored);
  assert.ok(scored.score > 55);
  assert.equal(scoreParent(child, stranger, NOW), null);
});

test('a candidate that started after the child is not its parent', () => {
  const child = seenFromAgent(agent('w1:p2'), NOW - 10_000, NOW - 10_000);
  const later = seenFromAgent(agent('w1:p1'), NOW - 5_000, NOW - 5_000);
  assert.equal(scoreParent(child, later, NOW), null);
});

test('different workspace and cwd is not a launch link', () => {
  const child = seenFromAgent(agent('w2:p1', { ws: 'w2', tab: 'w2:t1', cwd: '/elsewhere' }), NOW, NOW - 1_000);
  const other = seenFromAgent(agent('w1:p1', { ws: 'w1', tab: 'w1:t1' }), NOW - 10_000, NOW - 10_000);
  assert.equal(scoreParent(child, other, NOW), null);
});

test('same cwd links across workspaces (agent launched into another workspace)', () => {
  const child = seenFromAgent(agent('w2:p1', { ws: 'w2', tab: 'w2:t1' }), NOW, NOW - 1_000);
  const other = seenFromAgent(agent('w1:p1', { ws: 'w1', tab: 'w1:t1' }), NOW - 10_000, NOW - 10_000);
  assert.ok(scoreParent(child, other, NOW));
});

test('attribute links a chain oldest-first without cycles', () => {
  const model = { seen: new Map(), edges: new Map() };
  const a = seenFromAgent(agent('w1:p1'), NOW - 300_000, NOW - 300_000);
  const b = seenFromAgent(agent('w1:p2'), NOW - 200_000, NOW - 200_000);
  const c = seenFromAgent(agent('w1:p3'), NOW - 100_000, NOW - 100_000);
  for (const row of [a, b, c]) model.seen.set(row.key, row);
  const edges = attribute(model, NOW, null, {});
  assert.equal(edges.length, 2);
  assert.equal(model.edges.get(b.key).parent, a.key);
  assert.equal(model.edges.get(c.key).parent, b.key);
  assert.equal(wouldCycle(model.edges, a.key, c.key), true);
  const later = seenFromAgent(agent('w1:p4'), NOW - 1_000, NOW - 1_000);
  model.seen.set(later.key, later);
  attribute(model, NOW, [later.key], {});
  assert.equal(model.edges.get(later.key).parent, c.key);
});

test('an override wins over the heuristic', () => {
  const model = { seen: new Map(), edges: new Map() };
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 120_000);
  const child = seenFromAgent(agent('w1:p2'), NOW, NOW - 1_000);
  const forced = seenFromAgent(agent('w1:p3', { cwd: '/elsewhere' }), NOW - 30_000, NOW - 30_000);
  for (const row of [parent, child, forced]) model.seen.set(row.key, row);
  attribute(model, NOW, null, { [child.pane]: forced.pane });
  assert.equal(model.edges.get(child.key).parent, forced.key);
  assert.equal(model.edges.get(child.key).why, 'override');
});

test('the model reduces append-only records and flattenTree nests children', () => {
  const model = buildModel([
    { k: 'seen', t: NOW - 50_000, key: 'a', pane: 'w1:p1', agent: 'claude', title: 'A', tab: 'w1:t1', ws: 'w1', cwd: '/repo', status: 'working', firstSeen: NOW - 50_000, start: NOW - 50_000, lastSeen: NOW - 50_000, gone: false },
    { k: 'seen', t: NOW, key: 'b', pane: 'w1:p2', agent: 'codex', title: 'B', tab: 'w1:t2', ws: 'w1', cwd: '/repo', status: 'working', firstSeen: NOW, start: NOW, lastSeen: NOW, gone: false },
    { k: 'stat', t: NOW, key: 'a', status: 'idle' },
    { k: 'edge', t: NOW, child: 'b', parent: 'a', why: 'same cwd', score: 95 },
    { k: 'gone', t: NOW + 1, key: 'b' },
  ]);
  assert.equal(model.seen.get('a').status, 'idle');
  assert.equal(model.seen.get('b').gone, true);
  assert.equal(model.edges.get('b').parent, 'a');

  const tree = flattenTree({
    agents: [agent('w1:p1', { terminal: 'a', kind: 'claude' }), agent('w1:p2', { terminal: 'b', kind: 'codex' })],
    tabs: [{ tab_id: 'w1:t1', number: 0, label: 'one' }, { tab_id: 'w1:t2', number: 1, label: 'two' }],
    workspaces: [{ workspace_id: 'w1', number: 0, label: 'ws' }],
  }, model);
  assert.equal(tree.rows.length, 2);
  assert.equal(tree.rows[1].depth, 1);
  assert.equal(tree.rows[1].node.key, 'b');
});

test('siblingPanes picks the immediate split sibling only', () => {
  const snapshot = {
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1' },
      { pane_id: 'w1:p2', tab_id: 'w1:t1' },
      { pane_id: 'w1:p3', tab_id: 'w1:t1' },
    ],
    layouts: [{
      tab_id: 'w1:t1',
      panes: [
        { pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 41, height: 40 } },
        { pane_id: 'w1:p2', rect: { x: 41, y: 0, width: 21, height: 40 } },
        { pane_id: 'w1:p3', rect: { x: 62, y: 0, width: 20, height: 40 } },
      ],
      splits: [
        { id: 's0', rect: { x: 0, y: 0, width: 82, height: 40 } },
        { id: 's1', rect: { x: 41, y: 0, width: 41, height: 40 } },
      ],
    }],
  };
  assert.deepEqual(siblingPanes(snapshot, 'w1:p2'), ['w1:p3']);
});

test('a sibling pane outranks an equally close same-cwd agent', () => {
  const model = { seen: new Map(), edges: new Map(), focus: [] };
  const realParent = seenFromAgent(agent('w1:p1'), NOW - 40_000, NOW - 40_000);
  const impostor = seenFromAgent(agent('w1:p2'), NOW - 30_000, NOW - 30_000);
  const child = seenFromAgent(agent('w1:p3'), NOW - 1_000, NOW - 1_000);
  for (const row of [realParent, impostor, child]) model.seen.set(row.key, row);
  attribute(model, NOW, [child.key], {}, { siblings: new Set([realParent.key]) });
  assert.equal(model.edges.get(child.key).parent, realParent.key);
  assert.match(model.edges.get(child.key).why, /sibling pane/);
});

test('the pane focused just before the launch wins when no sibling exists', () => {
  const model = { seen: new Map(), edges: new Map(), focus: [] };
  const focused = seenFromAgent(agent('w1:p1'), NOW - 40_000, NOW - 40_000);
  const other = seenFromAgent(agent('w1:p2'), NOW - 30_000, NOW - 30_000);
  const child = seenFromAgent(agent('w1:p3'), NOW - 1_000, NOW - 1_000);
  for (const row of [focused, other, child]) model.seen.set(row.key, row);
  model.focus.push({ t: NOW - 2_000, pane: focused.pane });
  attribute(model, NOW, [child.key], {}, { focusKey: lastFocusKey(model, child.pane, NOW) });
  assert.equal(model.edges.get(child.key).parent, focused.key);
  assert.match(model.edges.get(child.key).why, /focused when launched/);
});

test('the reducer keeps a bootstrap launch time as last activity', () => {
  const model = buildModel([
    { k: 'seen', t: NOW, key: 'a', pane: 'w1:p1', agent: 'claude', title: 'A', tab: 'w1:t1', ws: 'w1', cwd: '/repo', status: 'idle', firstSeen: NOW - 600_000, start: NOW - 600_000, lastSeen: NOW - 600_000, gone: false },
  ]);
  assert.equal(model.seen.get('a').start, NOW - 600_000);
  assert.equal(model.seen.get('a').firstSeen, NOW - 600_000);
  assert.equal(model.seen.get('a').lastSeen, NOW - 600_000);
});
