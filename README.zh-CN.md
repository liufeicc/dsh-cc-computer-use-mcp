[English](README.md) | 中文

# dsh-cc-computer-use-mcp

把本地的 [cc-computer-use](https://github.com/liufeicc/cc-computer-use) MCP server 接入 DeepSeek Harness——
**每个 root 会话一份独立进程**，于是每个会话各有一块自己的 Xephyr 隔离屏和一条私有 AT-SPI 总线。

## 它加了什么

profile `web` 里多一行 Host 插件：

```
id: cc-cu-per-agent
name: '@local/dsh-cc-computer-use-mcp'
```

它监听 `agent/created`，对**每个 root agent** 在它自己的 `agent.ctx` 上挂一份
`@deepseek-ai/dsh-mcp-client`。于是模型工具表里多出 17 个工具，命名格式
`mcp__cc-computer-use__<原工具名>`：

| 工具 | 用途 |
|---|---|
| `get_ui_tree` | 读无障碍树（结构化文本，主要感知手段） |
| `get_screen_text` | OCR 出带坐标的文本（灰区应用的主要感知手段） |
| `find_element` / `element_info` | 按文本/角色/应用搜元素 |
| `click` / `double_click` / `type_text` / `press_key` / `scroll` / `drag` | 元素级优先的三级操作 |
| `get_last_click_image` | 回看最近一次坐标点击的实际落点 |
| `act_sequence` | 一串动作一次提交（省掉往返，实测往返 30~70s 而操作只要零点几秒） |
| `get_screen_layout` / `screenshot` | 屏幕布局 / 截图 |
| `list_windows` / `wait_window` / `launch_app` | 窗口枚举 / 等窗口 / 在目标 display 上起应用 |

## 挂载由「工作区 MCP 开关」决定（2026-10-23 起）

这些工具注册在**各 agent 自己的层**（scope-local），全局口径看不见，所以
`@local/dsh-mcp-workspace-policy` 的 MCP 菜单原先**列不出它**，`restrict` 也管不到它。
现在两边接上：

- 本插件向策略服务 `declarePerAgent({ name })` 声明自己 → 菜单里出现 `cc-computer-use`
  这一项，hint 与别的 server 一样显示工具数（由宿主从挂载了它的活会话里数出来）；
- **没勾选就不挂**：连 MCP 进程、Xephyr、AT-SPI 总线都不起（默认关，与全局 MCP 一致）；
- 勾选/取消后策略服务发 `mcp-workspace/changed`，本插件对该工作区的活会话就地
  挂载 / `fiber.dispose()` 卸载，子进程退出、屏由 `atexit` 回收；
- 策略服务不在（没装、或旧版本没有声明接口）时 **fail open**：退回改造前的行为，
  每个 root 会话照常挂一份 —— 不能因为策略缺失把用户的工具干掉。

> ⚠️ 上线后第一件事：在 MCP 菜单里给需要电脑操作的工作区**勾上** `cc-computer-use`。
> 默认关意味着没勾的工作区（包括 `dsh`）不会再有这批工具。

插件热重载时，旧实例挂的 fiber 记在 `agent[Symbol.for('dsh-cc-computer-use-mcp/mounted-fiber')]`
上，新实例**认领**它再按最新选择决定保留或卸载 —— 否则会挂出第二份进程，撞上
mcp-client 的 serverName 占用检查。

## 为什么是「每个会话一个进程」

### 先看原来的问题

cc-computer-use 的隔离屏是「**一个 MCP server 进程 = 一块 Xephyr + 一条私有 AT-SPI 总线**」。
它原本假设 MCP server 由 Claude Code 按会话拉起（一会话一进程），但 DSH 的
`@deepseek-ai/dsh-mcp-client` 挂在 **profile 作用域**（`scopeOf(ctx) ?? ctx.root`），
整个 dsh 进程只 spawn 一个 server。于是所有会话共用：

- 同一块 Xephyr（同一套 X11 指针/键盘焦点）
- 同一个 i3 窗口树 —— A 用 `launch_app` 起的窗口，B 的 `list_windows` 也看得见，
  B 的 `click` 可能点到 A 的窗口上
- 同一份 `RefTable`（ref 号会串）、同一把 `ScreenLock`（一个会话持锁，另一个被拒）
- 同一条私有 AT-SPI 总线

两个 agent 同时用就互相抢——表现就是「抢隔离屏」。

### 为什么不能「一个进程里按会话开多块屏」

那条路看着更省进程，但撞上 libatspi 的硬约束：`atspi_init()` 是**进程级、一次性**的，
一个进程只能绑一条 AT-SPI 总线；跨总线 `exit+init` 实测会损坏其内部状态
（见 cc-computer-use 的 `backend/linux/atspi.py` 里 `_BUS_STALE_ERROR` 的注释）。
两块屏必然两条总线，所以**两块屏必须两个进程**。这也正是 cc-computer-use 自己的设计假设。

### 为什么只挂 root agent

subagent 与主 agent 是同一个任务的两只手，本就该在同一块屏上协作（串行由
cc-computer-use 的屏锁保证）。而 DSH 的工具视图沿 **scope 祖先链**继承
（`ToolRuntime.view` → `chainLayers`：全局层 + 祖先链每一层），所以 subagent 自动看到
父 agent 挂的这批工具，不需要、也不应该再起一个进程——否则会多出一块没人用的屏。

判断「子会话」用了三条判据，任一条成立即跳过：`agent.parentAgent`、
`session.header.origin === 'subagent'`、`session.header.delegationDepth > 0`。

### 生命周期

`agent.ctx` 是 agent-local 的作用域，文档原话是「its contributions are agent-local,
unwind on disposal」。所以会话关掉 → 插件回卷 → MCP 子进程退出 → 它起的 Xephyr 由
cc-computer-use 的 `atexit` 回收，不留孤儿屏。

## 为什么 `serverName` 可以复用同名

工具经 `ctx.tools.register` 注册成 **scope-local**。DSH 源码里那条重名报错的原话是：

> `tool "X" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`

所以多个 agent 用同一个 `serverName: cc-computer-use` 安全，模型看到的工具名也不变。

## 安装 / 新环境注意

1. cc-computer-use 的冻结产物必须在 `config.command` 指向的路径存在
   （`<cc-computer-use 仓库>/dist/computer-use-mcp`）。改了源码要重跑它的 `build.sh`。
2. **本包需要 `@deepseek-ai/dsh-mcp-client` 可解析**。插件的 `package.json` 没声明它
   （profile 里没有 `@deepseek-ai/*`），所以靠一个软链：

   ```bash
   mkdir -p node_modules/@deepseek-ai
   ln -sfn <dsh 安装目录>/node_modules/@deepseek-ai/dsh-mcp-client \
           node_modules/@deepseek-ai/dsh-mcp-client
   ```

   `node_modules/` 已在 `.gitignore` 里，换机器/重装后要重建这条软链。
   DSH 升级若换了安装目录，同样要重建。
3. profile 里 `@local/dsh-cc-computer-use-mcp` 的 `link:` 依赖与
   `node_modules/@local` 软链指向本目录（与其他本地 bundle 一致）。

## 验证「两个会话各一块屏」

1. 在两个会话里各调用一次 `mcp__cc-computer-use__get_ui_tree`（首次使用才会惰性起屏）。
2. 看进程与屏号：

   ```bash
   ps -ef | grep -E "computer-use-mcp|Xephyr" | grep -v grep
   ls -d /tmp/cc-cu-at-spi-d* 2>/dev/null
   ```

   应当看到 **2 个** `computer-use-mcp` 进程、**2 个**不同屏号的 Xephyr、
   **2 个**不同的 `/tmp/cc-cu-at-spi-d<num>-*` 目录。
3. 在 A 会话 `launch_app` 起一个应用，在 B 会话 `list_windows` —— B 不该看到 A 的窗口。

## 离线测试

```bash
node test/gating.mjs
```

不启动任何进程、不需要宿主：用假 ctx 验证门控逻辑（勾了才挂、取消即卸、子会话不挂、
无策略时 fail open、热重载认领旧 fiber）。

## 许可证

本项目采用 MIT 协议开源，详见 [LICENSE](LICENSE)。
