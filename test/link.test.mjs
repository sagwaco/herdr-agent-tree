import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { paths, refreshCurrent, setup } from '../link.mjs';

const tempHome = () => mkdtemp(join(tmpdir(), 'agent-tree-link-'));

test('refreshCurrent does nothing before setup', async () => {
  const p = paths({}, await tempHome());
  assert.equal(await refreshCurrent('/install/a', p), false);
});

test('setup links through CURRENT and refreshCurrent moves it after an update', async () => {
  const home = await tempHome();
  const p = paths({}, home);
  await setup('/install/a', p);
  assert.equal(await readlink(p.current), '/install/a');
  assert.equal(await readlink(join(home, '.local/bin/agent-tree')), join(p.current, 'hier.mjs'));
  assert.equal(await readlink(join(home, '.claude/skills/agent-tree')), join(p.current, 'skills/agent-tree'));

  assert.equal(await refreshCurrent('/install/a', p), false);
  assert.equal(await refreshCurrent('/install/b', p), true);
  assert.equal(await readlink(p.current), '/install/b');
});

test('setup keeps a real directory the user made', async () => {
  const home = await tempHome();
  const p = paths({}, home);
  await mkdir(join(home, '.agents/skills/agent-tree'), { recursive: true });
  const report = await setup('/install/a', p);
  assert.ok(report.some((line) => line.startsWith('skipped') && line.includes('.agents')));
  assert.equal(await readlink(join(home, '.local/bin/agent-tree')), join(p.current, 'hier.mjs'));
});
