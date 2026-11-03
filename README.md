# Agent Tree

A local Herdr plugin that shows a tree of agents and the subagents they launched.
Roots are agents nobody appears to have launched; children are agents Herdr
detected in a pane right after another agent started them.

```
Agent tree — 5 agents, 3 roots
pi  π - Developer  [1 · Developer]  working
└─ codex  Clean up MacBook disk space  [2 · Developer]  idle
  └─ claude  disk-review  [Disk cleanup safety review]  idle
claude  Socket APK conversion release prep  [1 · socket-baseos]  working
claude  Helium macOS Swift browser chrome  [1 · neon]  idle
```

## Install and run

Requires `node` on PATH.

```bash
herdr plugin install sagwaco/herdr-agent-tree
herdr plugin action invoke herdr-agent-tree
```

Optional: put the `agent-tree` CLI and the coding-agent skill on your machine:

```bash
herdr plugin action invoke herdr-agent-tree.setup
```

This links `~/.local/bin/agent-tree`, `~/.agents/skills/agent-tree` and
`~/.claude/skills/agent-tree` through `~/.local/share/herdr-agent-tree`, which
points at the installed plugin. After `herdr plugin update`, the plugin's event
hook moves that link to the new install, so you do not run setup again. Setup
never replaces a real file or directory at those paths. Make sure `~/.local/bin`
is on PATH. To remove them after `herdr plugin uninstall herdr-agent-tree`:

```bash
rm ~/.local/share/herdr-agent-tree ~/.local/bin/agent-tree ~/.agents/skills/agent-tree ~/.claude/skills/agent-tree
```

For development, link a checkout instead: `herdr plugin link /path/to/herdr-agent-tree`.

The action opens a split pane next to the focused pane. Running it again focuses
the pane that is already open instead of opening a second copy. The pane also
runs standalone as a one-shot printer when stdout is not a TTY:

```bash
HERDR_SOCKET_PATH=... HERDR_PLUGIN_STATE_DIR=... node tree-ui.mjs
```

Bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr-agent-tree.herdr-agent-tree"
description = "agent tree"
```

### Pane keys

| Key | Action |
| --- | --- |
| `r` | refresh now (it also refreshes every 2s) |
| `↑` / `k`, `↓` / `j` | move the selection |
| `enter` / `f` | focus the selected agent's pane |
| `q` / `ctrl+c` | close the tree pane |

## How "subagent" is decided

Herdr's API exposes panes, agents and events, but no parent/child link. The
plugin therefore infers it from evidence, strongest first:

1. **Sibling pane.** Herdr splits a pane in two; an agent that launches a
   subagent in the same tab leaves the child as a sibling of its own pane.
2. **Focus.** The agent focused just before the child pane appeared is usually
   the one that called `herdr pane split`/`agent start`. Only used when the child
   is younger than two minutes.
3. **Workspace + cwd + launch proximity.** For a new tab or workspace the child
   usually shares the parent's workspace and cwd, and the parent is the agent
   that started closest before the child.
4. **Same tab.** A same-tab agent with recent activity is preferred when no cwd
   match exists.

Each edge records why it was chosen; select a child row to see the reason in the
detail line. Edges are written once and kept, so the tree is stable across
refreshes. A parent must have started before its child and cycles are dropped.

## Declaring the hierarchy (agent API)

An orchestrator that launches subagents knows the tree it built, so it can
declare it instead of leaving the link to inference. The declaration is a JSON
file in the plugin config dir:

```bash
herdr plugin config-dir herdr-agent-tree   # → …/plugins/config/herdr-agent-tree
```

```json
{
  "edges": { "w2:p9X": "wA:p1" },
  "roots": ["w2:p9T"]
}
```

- Keys of `edges` are children, values are their parents. Either id may be a
  pane id (`w1:p2`) or a terminal id (`term_…`, the id the lineage log keys on).
- `roots` names agents that have no parent even when the rules would attach one.
- A bare `{ "w1:p2": "w1:p1" }` map is also accepted.
- A declared edge is labelled `declared` in the tree pane and outranks
  `overrides.json` and every inference rule, including launch-time ordering.
- Anything not declared keeps using the rules above, so the file can describe a
  single subtree and leave the rest to inference. Written files are replaced
  atomically, so a refresh never reads a half-written tree.

Write the file through the CLI, which merges instead of overwriting and refuses
self-parents and loops. `hier.mjs` is installed on PATH as `agent-tree`, so
coding agents can use it without looking up the plugin path:

```bash
agent-tree path                    # print the hierarchy file path
agent-tree get                     # print the declared hierarchy
agent-tree tree                    # the live tree, with each parent's source
agent-tree set w2:p9Y              # parent = the pane running this command
agent-tree set w2:p9Y w2:p9X       # explicit parent
agent-tree root w2:p9T             # this agent is a root, not a subagent
agent-tree unset w2:p9Y            # drop the declaration; inference decides again
agent-tree clear                   # remove every declaration
```

`set` prints the new hierarchy as JSON. Deleting `hierarchy.json` is the same as
`clear`. Without the `agent-tree` symlink, run `node <plugin_root>/hier.mjs`.

`agent-tree tree` and the tree pane label every parent: `declared` for a
hierarchy entry, `override` for `overrides.json`, and `inferred: <reasons>` when
the rules chose it. An inferred parent among an orchestrator's own children is
the signal that a declaration is missing.

`skills/agent-tree/SKILL.md` in this repo carries the same instructions for
coding agents; symlink it into `~/.agents/skills` (and `~/.claude/skills`) so the
models that orchestrate know the API.

### Correcting an edge

Create `overrides.json` in the plugin state directory
(`herdr plugin config-dir herdr-agent-tree` shows the config dir; state lives in
`~/.local/state/herdr/plugins/herdr-agent-tree` on macOS/Linux). Map the child's
terminal id or pane id to the parent's:

```json
{
  "wA:p2D": "wA:p2B"
}
```

Overrides win over inference. To rebuild all inferred edges from scratch, stop
the plugin's panes and delete `lineage.jsonl` in that state directory. Prefer
`hierarchy.json` (see above): it is the same map, agent-readable, and also
supports declaring roots.

## Files

| File | Purpose |
| --- | --- |
| `herdr-plugin.toml` | manifest: action, pane, event hooks |
| `hook.mjs` | event hook; appends lineage records to `lineage.jsonl` |
| `hier.mjs` | read/write the declared tree (`hierarchy.json`); installed as `agent-tree` |
| `skills/agent-tree/SKILL.md` | model-facing instructions for declaring the tree |
| `tree-ui.mjs` | tree pane; reads the Herdr snapshot + lineage log |
| `open.mjs` | action; opens or focuses the tree pane |
| `link.mjs` | `setup` action; links the CLI and skill, and keeps them on the current install |
| `lib.mjs` | socket RPC, lineage log reducer and parent inference |
| `test/lineage.test.mjs` | unit tests for inference and geometry |
| `test/hierarchy.test.mjs` | unit tests for the declared hierarchy |

## Limits

- The link is inferred, not read from Herdr. A user-created pane in the same
  workspace/cwd can be misattributed; declare the edge to be certain.
- A declared id that is not live yet is ignored until that agent appears.
- Two agents writing `hierarchy.json` at the same instant can lose one edge;
  the CLI has no file lock.
- Agents launched before the plugin was linked are bootstrapped from process
  start times and geometry; history from before the link is unavailable.
- The lineage log is not rotated. On a long-lived server with thousands of agent
  events, trim or delete `lineage.jsonl`.
- Local plugin only; no remote-machine support.
