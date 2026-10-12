English | [中文](README.zh-CN.md)

# dsh-cc-computer-use-mcp

A **pure-configuration bundle** that wires a local [cc-computer-use](https://github.com/liufeicc/cc-computer-use) MCP server into
DeepSeek Harness — only two files, **no Host/Client entry-point code**: all behavior is carried by the
single plugin row `@deepseek-ai/dsh-mcp-client`.

## What it adds

One additional Host plugin row in the `web` profile:

```
id: mcp-cc-computer-use
name: @deepseek-ai/dsh-mcp-client
```

It launches `cc-computer-use/dist/computer-use-mcp` over stdio, so the model's tool table gains 17 tools,
named `mcp__cc-computer-use__<original tool name>`:

| Tool | Purpose |
|---|---|
| `mcp__cc-computer-use__get_ui_tree` | Read the accessibility tree (structured text; the primary perception method) |
| `mcp__cc-computer-use__get_screen_text` | OCR text with coordinates (the primary perception method for gray-area apps) |
| `mcp__cc-computer-use__find_element` / `element_info` | Search for elements by text/role/app |
| `mcp__cc-computer-use__click` / `double_click` / `type_text` / `press_key` / `scroll` / `drag` | Three-tier operations, element-level first |
| `mcp__cc-computer-use__get_last_click_image` | Review where the most recent coordinate click actually landed |
| `mcp__cc-computer-use__act_sequence` | Submit a whole sequence of actions in one call (saves round trips; measured round trips take 30~70s while the operations themselves take only a fraction of a second) |
| `mcp__cc-computer-use__get_screen_layout` / `screenshot` | Screen layout / screenshot |
| `mcp__cc-computer-use__list_windows` / `wait_window` / `launch_app` | Enumerate windows / wait for a window / launch an app on a target display |

## Why it is configured this way

- **Use the frozen artifact instead of conda python**: `dist/computer-use-mcp` is a thin wrapper around a
  PyInstaller onedir build, so it does not require a conda environment on `PATH`, and it starts faster.
  After changing the source you must re-run `bash build.sh` for the change to take effect.
  If you want source changes to take effect immediately during development, replace `command` with conda's
  `python` + `args: [-m, computer_use_mcp.server]` and add `PYTHONPATH` (see option B in section 6 of the
  cc-computer-use project README).
- **`serverName: cc-computer-use`**: the cc-computer-use project README reports a measured warning that
  `computer-use` cannot be used. `-` is inside the DeepSeek function-name contract `[A-Za-z0-9_-]`, so it will
  not be renamed by hashing: the tool names stay stable and can be written into permission rules long-term.
- **`DISPLAY` via `!!js process.env.DISPLAY`**: the server child process must inherit the X11 display in order
  to read the screen / inject input; hard-coding `:1` breaks as soon as the display changes, whereas
  referencing the host's existing value always works. By the way: the child-process environment is sanitized,
  but sanitization only strips variables shaped like `KEY|PASSWORD|SECRET|TOKEN` plus all `DSH_*`;
  `DISPLAY`/`PATH`/`HOME`/locale are all preserved — writing them out explicitly here is
  **declaring a dependency**, not bypassing sanitization.
- **`failOnStartupError: true`**: refuse to activate if the connection cannot be established. Better to blow
  up once at startup than to have "a bunch of tools quietly missing from the tool table" and then have the
  model appear unable to use the computer during the conversation.

## Maintenance

- Changed `cordis.patch.yml`: the profile uses `patchReload: live`, so saving reloads it and the server
  connection is rebuilt in place.
- Changed `package.json` (package name/version): the harness must be restarted to load the new module
  generation.
- Uninstall: `plugin_manager`'s `remove_bundle`, with target `@local/dsh-cc-computer-use-mcp`.

## License

This project is open-sourced under the MIT License. See [LICENSE](LICENSE).
