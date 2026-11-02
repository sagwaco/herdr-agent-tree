import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyDeclared, attribute, buildModel, flattenTree, normalizeHierarchy, readHierarchy, seenFromAgent,
} from '../lib.mjs';
import { clearHierarchy, configDir, hierarchyPath, setEdge, setRoot, unsetAgent } from '../hier.mjs';

const NOW = 1_800_000_000_000;
const agent = (pane, { terminal = `term_${pane}`, tab = 'w1:t1', ws = 'w1', cwd = '/repo', status = 'working' } = {}) => ({
  pane_id: pane, terminal_id: terminal, agent: 'claude', agent_status: status, tab_id: tab, workspace_id: ws,
  cwd, foreground_cwd: cwd, title: `title ${pane}`,
});

const modelWith = (rows) => {
  const model = { seen: new Map(), edges: new Map(), focus: [] };
  for (const row of rows) model.seen.set(row.key, row);
  return model;
};

const tempDir = () => mkdtemp(join(tmpdir(), 'agent-tree-hier-'));

test('normalizeHierarchy reads both the canonical document and a bare map', () => {
  assert.deepEqual(normalizeHierarchy({ edges: { a: 'b' }, roots: ['r'] }), { edges: { a: 'b' }, roots: ['r'] });
  assert.deepEqual(normalizeHierarchy({ a: 'b', c: { parent: 'd' } }), { edges: { a: 'b', c: 'd' }, roots: [] });
  assert.deepEqual(normalizeHierarchy({ edges: { a: 7 }, roots: [3, 'r'] }), { edges: {}, roots: ['r'] });
  assert.deepEqual(normalizeHierarchy(null), { edges: {}, roots: [] });
  assert.deepEqual(normalizeHierarchy(['a']), { edges: {}, roots: [] });
});

test('a declared edge beats the inference rules and is labelled', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 60_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 1_000, NOW - 1_000);
  const declaredParent = seenFromAgent(agent('w1:p3', { cwd: '/elsewhere' }), NOW - 30_000, NOW - 30_000);
  const model = modelWith([parent, child, declaredParent]);
  attribute(model, NOW, null, {});
  assert.equal(model.edges.get(child.key).parent, parent.key);
  applyDeclared(model, { edges: { 'w1:p2': 'w1:p3' }, roots: [] });
  assert.equal(model.edges.get(child.key).parent, declaredParent.key);
  assert.equal(model.edges.get(child.key).why, 'declared');
});

test('a declared edge may point at a parent the rules would reject', () => {
  // Different workspace, tab and cwd, and the parent started later: inference
  // refuses this link, but a declaration is explicit intent.
  const parent = seenFromAgent(agent('w2:p1', { ws: 'w2', tab: 'w2:t1', cwd: '/other' }), NOW - 1_000, NOW - 1_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 30_000, NOW - 30_000);
  const model = modelWith([parent, child]);
  attribute(model, NOW, null, {});
  assert.equal(model.edges.get(child.key), undefined);
  applyDeclared(model, { edges: { [child.pane]: parent.pane }, roots: [] });
  assert.equal(model.edges.get(child.key).parent, parent.key);
});

test('a declared root drops an inferred parent', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 60_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 1_000, NOW - 1_000);
  const model = modelWith([parent, child]);
  attribute(model, NOW, null, {});
  assert.ok(model.edges.has(child.key));
  applyDeclared(model, { edges: {}, roots: [child.key] });
  assert.equal(model.edges.has(child.key), false);
});

test('declarations for agents that are not live yet, self-parents and loops are ignored', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 60_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 1_000, NOW - 1_000);
  const model = modelWith([parent, child]);
  applyDeclared(model, {
    edges: { [child.pane]: 'w1:nope', 'w1:p9': parent.pane, [parent.pane]: parent.pane },
    roots: ['w1:missing'],
  });
  assert.equal(model.edges.size, 0);
});

test('hier set/unset/root/clear round-trips through hierarchy.json', async () => {
  const dir = await tempDir();
  await setEdge({ dir, child: 'w1:p2', parent: 'w1:p1' });
  await setEdge({ dir, child: 'w1:p3', parent: 'w1:p2' });
  assert.deepEqual(await readHierarchy(dir), { edges: { 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p2' }, roots: [] });

  await assert.rejects(() => setEdge({ dir, child: 'w1:p1', parent: 'w1:p3' }), /loop/);
  await assert.rejects(() => setEdge({ dir, child: 'w1:p1', parent: 'w1:p1' }), /own parent/);
  // Declaring a parent also clears that child's own root marker.
  await setRoot({ dir, agent: 'w1:p4' });
  await setEdge({ dir, child: 'w1:p4', parent: 'w1:p1' });
  assert.deepEqual(await readHierarchy(dir), {
    edges: { 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p2', 'w1:p4': 'w1:p1' },
    roots: [],
  });

  await unsetAgent({ dir, agent: 'w1:p3' });
  assert.deepEqual(await readHierarchy(dir), {
    edges: { 'w1:p2': 'w1:p1', 'w1:p4': 'w1:p1' },
    roots: [],
  });

  await clearHierarchy(dir);
  assert.deepEqual(await readHierarchy(dir), { edges: {}, roots: [] });
});

test('a hand-written bare map is read as a hierarchy', async () => {
  const dir = await tempDir();
  await writeFile(hierarchyPath(dir), JSON.stringify({ 'w1:p2': 'w1:p1' }));
  assert.deepEqual(await readHierarchy(dir), { edges: { 'w1:p2': 'w1:p1' }, roots: [] });
});

test('configDir prefers the Herdr-provided env over shelling out', () => {
  assert.equal(configDir({ HERDR_PLUGIN_CONFIG_DIR: '/cfg' }), '/cfg');
});

test('the tree nests a declared child under its declared parent', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 60_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 1_000, NOW - 1_000);
  const model = buildModel([parent, child]);
  applyDeclared(model, { edges: { [child.pane]: parent.pane }, roots: [] });
  const tree = flattenTree({
    agents: [agent('w1:p1'), agent('w1:p2')],
    tabs: [{ tab_id: 'w1:t1', number: 0, label: 'one' }],
    workspaces: [{ workspace_id: 'w1', number: 0, label: 'ws' }],
  }, model);
  assert.equal(tree.rows[1].node.key, child.key);
  assert.equal(tree.rows[1].depth, 1);
  assert.equal(tree.rows[1].node.why, 'declared');
});

test('a parent chosen by the rules is labelled as inferred', () => {
  const parent = seenFromAgent(agent('w1:p1'), NOW - 60_000, NOW - 60_000);
  const child = seenFromAgent(agent('w1:p2'), NOW - 1_000, NOW - 1_000);
  const model = buildModel([parent, child]);
  attribute(model, NOW, null, {});
  const tree = flattenTree({
    agents: [agent('w1:p1'), agent('w1:p2')],
    tabs: [{ tab_id: 'w1:t1', number: 0, label: 'one' }],
    workspaces: [{ workspace_id: 'w1', number: 0, label: 'ws' }],
  }, model);
  assert.match(tree.rows[1].node.why, /^inferred: /);
});
