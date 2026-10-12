[English](README.md) | 中文

# dsh-cc-computer-use-mcp

把本地的 [cc-computer-use](https://github.com/liufeicc/cc-computer-use) MCP server 接入 DeepSeek Harness 的**纯配置 bundle** ——
只有两个文件，**没有 Host/Client 入口代码**，全部行为由 `@deepseek-ai/dsh-mcp-client` 那一行插件承担。

## 它加了什么

profile `web` 里多一行 Host 插件：

```
id: mcp-cc-computer-use
name: @deepseek-ai/dsh-mcp-client
```

以 stdio 方式拉起 `cc-computer-use/dist/computer-use-mcp`，于是模型工具表里多出 17 个工具，
命名格式 `mcp__cc-computer-use__<原工具名>`：

| 工具 | 用途 |
|---|---|
| `mcp__cc-computer-use__get_ui_tree` | 读无障碍树（结构化文本，主要感知手段） |
| `mcp__cc-computer-use__get_screen_text` | OCR 出带坐标的文本（灰区应用的主要感知手段） |
| `mcp__cc-computer-use__find_element` / `element_info` | 按文本/角色/应用搜元素 |
| `mcp__cc-computer-use__click` / `double_click` / `type_text` / `press_key` / `scroll` / `drag` | 元素级优先的三级操作 |
| `mcp__cc-computer-use__get_last_click_image` | 回看最近一次坐标点击的实际落点 |
| `mcp__cc-computer-use__act_sequence` | 一串动作一次提交（省掉往返，实测往返 30~70s 而操作只要零点几秒） |
| `mcp__cc-computer-use__get_screen_layout` / `screenshot` | 屏幕布局 / 截图 |
| `mcp__cc-computer-use__list_windows` / `wait_window` / `launch_app` | 窗口枚举 / 等窗口 / 在目标 display 上起应用 |

## 为什么这么配

- **用冻结产物而不是 conda python**：`dist/computer-use-mcp` 是 PyInstaller onedir 的薄 wrapper，
  因此不要求 conda 环境在 `PATH` 里，启动也更快。改动源码后要重跑 `bash build.sh` 才生效。
  开发期想改源码立即生效，就把 `command` 换成 conda 的 `python` + `args: [-m, computer_use_mcp.server]`
  并补 `PYTHONPATH`（见 cc-computer-use 项目 README 第六节 B 方案）。
- **`serverName: cc-computer-use`**：cc-computer-use 项目 README 实测告警「不能用 `computer-use`」。`-` 在 DeepSeek
  函数名契约 `[A-Za-z0-9_-]` 之内，所以不会被哈希改名，工具名稳定、可长期写进权限规则。
- **`DISPLAY` 走 `!!js process.env.DISPLAY`**：server 子进程必须继承 X11 display 才能读屏/注入，
  写死 `:1` 换 display 就废；引用宿主已有值即可。顺带说明：子进程环境会经过清洗，但清洗只剔除
  `KEY|PASSWORD|SECRET|TOKEN` 形状的变量与全部 `DSH_*`，`DISPLAY`/`PATH`/`HOME`/locale 都保留 ——
  这里显式写出是**声明依赖**，不是绕过清洗。
- **`failOnStartupError: true`**：连不上就拒绝激活。宁可启动时炸一次，也不要「工具表悄悄少了一堆工具」
  然后在对话里表现为模型"不会用电脑"。

## 维护

- 改了 `cordis.patch.yml`：profile 是 `patchReload: live`，保存即重载，server 连接会原地重建。
- 改了 `package.json`（包名/版本）：需要重启 harness 才能加载新的模块代际。
- 卸载：`plugin_manager` 的 `remove_bundle`，target 传 `@local/dsh-cc-computer-use-mcp`。

## 许可证

本项目采用 MIT 协议开源，详见 [LICENSE](LICENSE)。
