English | [中文](README.zh-CN.md)

# dsh-cc-computer-use-mcp

Wires a local [cc-computer-use](https://github.com/liufeicc/cc-computer-use) MCP server into DeepSeek Harness —
**one independent process per root session**, so every session gets its own Xephyr sandbox screen and its own
private AT-SPI bus.

## What it adds

One Host plugin row in profile `web`:

```
id: cc-cu-per-agent
name: '@local/dsh-cc-computer-use-mcp'
```

It listens for `agent/created` and mounts one `@deepseek-ai/dsh-mcp-client` on **each root agent's own
`agent.ctx`**. The model tool table then gains 17 tools named `mcp__cc-computer-use__<rawName>`:

| Tool | Purpose |
|---|---|
| `get_ui_tree` | Read the accessibility tree (structured text; the primary perception channel) |
| `get_screen_text` | OCR text with coordinates (the perception channel for grey-area apps) |
| `find_element` / `element_info` | Find elements by text/role/app |
| `click` / `double_click` / `type_text` / `press_key` / `scroll` / `drag` | Element-first three-tier actions |
| `get_last_click_image` | Look back at where the last coordinate click actually landed |
| `act_sequence` | Submit a batch of actions in one call |
| `get_screen_layout` / `screenshot` | Screen layout / screenshot |
| `list_windows` / `wait_window` / `launch_app` | Enumerate windows / wait for one / launch an app on the target display |

## Why one process per session

### The problem

A cc-computer-use sandbox is **one MCP server process = one Xephyr + one private AT-SPI bus**. It was designed
around Claude Code's model (one MCP server child per session), but DSH's `@deepseek-ai/dsh-mcp-client` is
mounted at **profile scope** (`scopeOf(ctx) ?? ctx.root`), so the whole dsh process spawns exactly one server.
Every session therefore shared:

- the same Xephyr (one X11 pointer/keyboard focus),
- the same i3 window tree — a window A launched with `launch_app` shows up in B's `list_windows`, and B's
  `click` can land on A's window,
- the same `RefTable` (ref numbers collide) and the same `ScreenLock` (one session holds it, the other is
  refused),
- the same private AT-SPI bus.

Two agents using it at once fight over the sandbox — the "they're stealing my sandbox" symptom.

### Why not several sandboxes in one process

That would use fewer processes, but it hits a hard libatspi constraint: `atspi_init()` is **process-wide and
one-shot**, so a process can bind exactly one AT-SPI bus, and `exit` + re-`init` against another bus is known
to corrupt its internal state (see `_BUS_STALE_ERROR` in cc-computer-use's `backend/linux/atspi.py`). Two
screens imply two buses, so **two screens require two processes**. This is also cc-computer-use's own design
assumption.

### Why only root agents

A subagent is the same task's other hand and should work on the same screen (serialization is provided by
cc-computer-use's screen lock). DSH's tool view inherits along the **scope ancestor chain**
(`ToolRuntime.view` → `chainLayers`: the global layer plus every ancestor layer), so a subagent already sees
the tools mounted by its parent and must not start another process — that would leave one sandbox orphaned.

Three predicates identify a subagent; any one being true skips the mount: `agent.parentAgent`,
`session.header.origin === 'subagent'`, `session.header.delegationDepth > 0`.

### Lifecycle

`agent.ctx` is agent-local: "its contributions are agent-local, unwind on disposal". Closing a session unwinds
the plugin, which disconnects the MCP child, which exits and lets cc-computer-use's `atexit` reclaim its
Xephyr. No orphan screens.

## Why the same `serverName` is safe

Tools register through `ctx.tools.register` as **scope-local**. DSH's own duplicate-name error spells out the
contract:

> `tool "X" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`

The same reasoning holds for `systemPrompt.section` (a scoped section shadows a global one) and
`mcpResources.register` (layered by the calling scope), so many agents can share `cc-computer-use` without
colliding, and the model-facing tool names stay stable.

## Installation / new-environment notes

1. The cc-computer-use frozen artifact must exist at `config.command`
   (`<cc-computer-use repo>/dist/computer-use-mcp`). Re-run its `build.sh` after changing its source.
2. **This package needs `@deepseek-ai/dsh-mcp-client` to be resolvable.** Its `package.json` does not declare
   it (profiles have no `@deepseek-ai/*`), so a symlink provides it:

   ```bash
   mkdir -p node_modules/@deepseek-ai
   ln -sfn <dsh install dir>/node_modules/@deepseek-ai/dsh-mcp-client \
           node_modules/@deepseek-ai/dsh-mcp-client
   ```

   `node_modules/` is git-ignored; recreate the link on a new machine and after a DSH upgrade that moves the
   install directory.
3. Profile `web` links `@local/dsh-cc-computer-use-mcp` here, like the other local bundles.

## Verifying two sessions get two screens

1. Call `mcp__cc-computer-use__get_ui_tree` once in each session (the sandbox starts lazily on first use).
2. Inspect processes and display numbers:

   ```bash
   ps -ef | grep -E "computer-use-mcp|Xephyr" | grep -v grep
   ls -d /tmp/cc-cu-at-spi-d* 2>/dev/null
   ```

   Expect **two** `computer-use-mcp` processes, **two** Xephyrs on different display numbers, and **two**
   distinct `/tmp/cc-cu-at-spi-d<num>-*` directories.
3. Launch an app with `launch_app` in session A and run `list_windows` in session B — B must not see A's window.

## License

MIT — see [LICENSE](LICENSE).
