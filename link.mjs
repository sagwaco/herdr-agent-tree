// Put the `agent-tree` CLI and the coding-agent skill on the user's machine,
// and keep them current across `herdr plugin update`.
//
// Each GitHub install lives in a new directory. A link into one install goes
// stale after an update. So the user-facing links point at one fixed link,
// CURRENT, and only CURRENT points into the install. The event hook calls
// refreshCurrent() from the running install, which moves CURRENT after an
// update. `setup` (the plugin action) creates CURRENT and the user links.
import { lstat, mkdir, readlink, rename, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function paths(env = process.env, home = homedir()) {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const current = join(data, 'herdr-agent-tree');
  return {
    current,
    links: [
      [join(home, '.local', 'bin', 'agent-tree'), join(current, 'hier.mjs')],
      [join(home, '.agents', 'skills', 'agent-tree'), join(current, 'skills', 'agent-tree')],
      [join(home, '.claude', 'skills', 'agent-tree'), join(current, 'skills', 'agent-tree')],
    ],
  };
}

const kind = async (path) => {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'link' : 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'none';
    throw error;
  }
};

// Replace a symlink atomically, so a reader never sees the path missing.
async function pointAt(path, target) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await symlink(target, tmp);
  await rename(tmp, path);
}

// Move CURRENT to root. Do nothing if the user never ran setup.
// ponytail: last writer wins. A hook from the old install that is still running
// during an update can point CURRENT back; the next event from the new install
// fixes it. Ask Herdr for the active plugin_root if that window matters.
export async function refreshCurrent(root, { current } = paths()) {
  if (!root || await kind(current) !== 'link') return false;
  if (await readlink(current) === root) return false;
  await pointAt(current, root);
  return true;
}

// Create CURRENT and the user links. Never replace a real file or directory.
export async function setup(root, { current, links } = paths()) {
  if (await kind(current) === 'other') throw new Error(`${current} exists and is not a symlink`);
  await pointAt(current, root);
  const report = [`${current} -> ${root}`];
  for (const [path, target] of links) {
    if (await kind(path) === 'other') {
      report.push(`skipped ${path}: exists and is not a symlink`);
      continue;
    }
    await pointAt(path, target);
    report.push(`${path} -> ${target}`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.HERDR_PLUGIN_ROOT || dirname(fileURLToPath(import.meta.url));
  for (const line of await setup(root)) console.log(line);
}
