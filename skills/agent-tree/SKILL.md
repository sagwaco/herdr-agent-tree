---
name: agent-tree
description: "Declare the hierarchy of subagents launched in Herdr, and read the agent tree, with the `agent-tree` command. Use when orchestrating subagents in Herdr, when an agent tree shows a wrong or missing parent, or when asked who launched which agent. Requires HERDR_ENV=1."
---

# Agent tree

Herdr does not record who launched whom. The `sang.agent-tree` plugin shows a
tree of agents and infers parents from pane geometry, focus and cwd, but an
orchestrator knows the truth. Declare it, and the tree stops guessing.

Declared edges win over inference. Anything you do not declare keeps using the
inference rules, so you can declare only your own children.

## Declare the subagents you launch

Run this in the pane of the agent that launched the child. The parent defaults
to the calling pane, so one short command per launch is enough:

```bash
agent-tree set w2:p9Y              # child, parent = this pane
agent-tree set w2:p9Y w2:p9X       # child and explicit parent
```

Do this right after `herdr agent start` returns, using the pane id it printed.
Declare only your direct reports: every orchestrator declares its own children
and nobody else's.

Other commands:

```bash
agent-tree get                     # the declared hierarchy as JSON
agent-tree path                    # the hierarchy file, if you want to read it directly
agent-tree root w2:p9T             # this agent is a root, not a subagent
agent-tree unset w2:p9Y            # drop the declaration; inference decides again
agent-tree clear                   # remove every declaration
```

`set` prints the new hierarchy and refuses self-parents and loops. An id is a
pane id (`w1:p2`) or a terminal id (`term_…`). A declared id that is not live
yet is ignored until that agent appears. Deleting the file equals `clear`.

## Read the current tree

```bash
agent-tree tree
```

That prints every live agent and, for a child, its parent and how the link was
chosen: `(declared)` for a declaration, `(inferred: why)` for the rules.
Anything labelled `inferred` among your own children is a declaration you
missed. `agent-tree get` prints only what is declared.

## When the command is missing

`agent-tree` is a symlink to the plugin's `hier.mjs`. If it is not on PATH, run
that file directly:

```bash
AT_ROOT="$(herdr plugin list --json | python3 -c 'import json,sys;print(next(p["plugin_root"] for p in json.load(sys.stdin)["result"]["plugins"] if p["plugin_id"]=="sang.agent-tree"))')"
node "$AT_ROOT/hier.mjs" set w2:p9Y
```

If `HERDR_ENV` is not 1, this agent is not running inside Herdr; stop and do
not touch another session's tree.
