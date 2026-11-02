#!/usr/bin/env node
// Model-facing hierarchy API. An orchestrator declares the tree it launched in
// hierarchy.json; anything undeclared still falls back to the inference rules
// in lib.mjs. Installed on PATH as `agent-tree`.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HIERARCHY_FILE, PLUGIN_ID, call, readHierarchy, wouldCycle } from './lib.mjs';
import { loadTree, plainTree } from './tree-ui.mjs';

const USAGE = `usage: agent-tree <command>

  path                 print the hierarchy file path
  get                  print the declared hierarchy as JSON
  tree                 print the live tree with each parent's source
  set <child> [parent] declare a child's parent (default: the calling pane)
  unset <child>        drop a declaration; inference decides again
  root <agent>         declare an agent as a root (no parent)
  clear                remove every declaration

<id> is a pane id (w1:p2) or a terminal id (term_…).`;

// The config dir is where Herdr keeps per-plugin files agents may read/write.
export function configDir(env = process.env) {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    return execFileSync(env.HERDR_BIN_PATH ?? 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

export const hierarchyPath = (dir) => join(dir, HIERARCHY_FILE);

const asEdges = (edges) => new Map(Object.entries(edges).map(([child, parent]) => [child, { parent }]));

// Replace atomically so a reader never sees a half-written tree.
// shortcut: no file lock, so two agents editing at the same instant can lose
// one edge. Add a lock if several orchestrators share one tree.
async function writeHierarchy(dir, hierarchy) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = hierarchyPath(dir);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(hierarchy, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return hierarchy;
}

export async function setEdge({ dir, child, parent }) {
  if (!child) throw new Error('a child agent id or pane id is required');
  if (!parent) throw new Error('a parent is required, or run inside the parent pane');
  if (child === parent) throw new Error('an agent cannot be its own parent');
  const { edges, roots } = await readHierarchy(dir);
  const next = { ...edges, [child]: parent };
  if (wouldCycle(asEdges(next), child, parent)) {
    throw new Error(`that would make a loop: ${child} is already an ancestor of ${parent}`);
  }
  return writeHierarchy(dir, { edges: next, roots: roots.filter((root) => root !== child) });
}

export async function setRoot({ dir, agent }) {
  if (!agent) throw new Error('an agent id or pane id is required');
  const { edges, roots } = await readHierarchy(dir);
  delete edges[agent];
  if (roots.includes(agent)) return { edges, roots };
  return writeHierarchy(dir, { edges, roots: [...roots, agent] });
}

export async function unsetAgent({ dir, agent }) {
  if (!agent) throw new Error('an agent id or pane id is required');
  const { edges, roots } = await readHierarchy(dir);
  if (!(agent in edges) && !roots.includes(agent)) return { edges, roots };
  delete edges[agent];
  return writeHierarchy(dir, { edges, roots: roots.filter((root) => root !== agent) });
}

export async function clearHierarchy(dir) {
  await rm(hierarchyPath(dir), { force: true });
  return { edges: {}, roots: [] };
}

export async function run(argv, { env = process.env, out = (text) => process.stdout.write(text) } = {}) {
  const [command, first, second] = argv;
  const dir = configDir(env);
  if (!dir) throw new Error('cannot locate the plugin config dir; pass HERDR_PLUGIN_CONFIG_DIR');
  const print = (value) => out(`${JSON.stringify(value)}\n`);

  switch (command) {
    case 'path':
      out(`${hierarchyPath(dir)}\n`);
      return;
    case 'get':
      out(`${JSON.stringify(await readHierarchy(dir), null, 2)}\n`);
      return;
    case 'tree': {
      const socketPath = env.HERDR_SOCKET_PATH;
      if (!socketPath) throw new Error('HERDR_SOCKET_PATH is not set; run this inside Herdr');
      out(plainTree(await loadTree(call(socketPath), env.HERDR_PLUGIN_STATE_DIR ?? dir, dir)));
      return;
    }
    case 'set':
      return void print(await setEdge({ dir, child: first, parent: second ?? env.HERDR_PANE_ID }));
    case 'unset':
      return void print(await unsetAgent({ dir, agent: first }));
    case 'root':
      return void print(await setRoot({ dir, agent: first }));
    case 'clear':
      return void print(await clearHierarchy(dir));
    default:
      throw new Error(USAGE);
  }
}

// The PATH shim is a symlink, so compare the real path, not argv[1].
const invoked = (() => {
  try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; }
})();

if (invoked && import.meta.url === invoked) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
