// Action entrypoint: open the tree pane, or focus the copy already running.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENTRYPOINT, PLUGIN_ID } from './lib.mjs';

const PANE_ID = /^w[\w-]+:p[\w-]+$/;
const PANE_FILE = 'pane.json';

function herdr(args) {
  return execFileSync(process.env.HERDR_BIN_PATH ?? 'herdr', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
}

function parsePane(output) {
  try {
    const parsed = JSON.parse(output);
    const candidates = [parsed?.result?.plugin_pane?.pane?.pane_id, parsed?.result?.pane?.pane_id, parsed?.result?.pane_id];
    return candidates.find((value) => typeof value === 'string' && PANE_ID.test(value)) ?? null;
  } catch { return null; }
}

function isLive(pane, run) {
  try {
    const info = JSON.parse(run(['pane', 'get', pane]));
    return info?.result?.pane?.pane_id === pane;
  } catch { return false; }
}

async function readSaved(stateDir) {
  try {
    const saved = JSON.parse(await readFile(join(stateDir, PANE_FILE), 'utf8'));
    return typeof saved?.pane === 'string' && PANE_ID.test(saved.pane) ? saved.pane : null;
  } catch { return null; }
}

export async function openTree({ stateDir = process.env.HERDR_PLUGIN_STATE_DIR, run = herdr } = {}) {
  const saved = stateDir ? await readSaved(stateDir) : null;
  if (saved && isLive(saved, run)) {
    try {
      run(['plugin', 'pane', 'focus', saved]);
      return { reused: saved };
    } catch { /* The pane can close between the check and the focus. */ }
  }
  const output = run([
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', ENTRYPOINT,
    '--placement', 'split', '--direction', 'right', '--focus',
  ]);
  const pane = parsePane(output);
  if (pane && stateDir) {
    try { await writeFile(join(stateDir, PANE_FILE), JSON.stringify({ pane }), { mode: 0o600 }); }
    catch { /* Reuse is optional. */ }
  }
  return { opened: pane, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openTree().then((result) => {
    if (result.reused) return;
    process.stdout.write(result.output ?? '');
  }).catch((error) => {
    process.stderr.write(`Agent tree pane unavailable: ${String(error?.stderr ?? error?.message ?? error).trim()}\n`);
    process.exitCode = 1;
  });
}
