/**
 * 每个 root agent 一份 cc-computer-use MCP 进程 —— 让并发的多个会话各有一块隔离屏。
 *
 * ═══ 问题（2026-10-21 实测）═══
 *
 * cc-computer-use 的隔离屏是「**一个 MCP server 进程 = 一块 Xephyr + 一条私有 AT-SPI
 * 总线**」。它原本假设 MCP server 由 Claude Code 按会话拉起（一会话一进程），但 DSH 的
 * `@deepseek-ai/dsh-mcp-client` 挂在 **profile 作用域**（`scopeOf(ctx) ?? ctx.root`），
 * 整个 dsh 进程只 spawn 一个 server。于是所有会话共用：
 *
 *   - 同一块 Xephyr（同一套 X11 指针/键盘焦点）
 *   - 同一个 i3 窗口树（A 起的窗口，B 的 list_windows 也看得见，B 的 click 可能点到
 *     A 的窗口上）
 *   - 同一份 RefTable（ref 号会串）、同一把 ScreenLock（一个会话持锁，另一个被拒）
 *   - 同一条私有 AT-SPI 总线
 *
 * 两个 agent 同时用就互相抢 —— 表现为「抢隔离屏」。
 *
 * ═══ 为什么不是「在一个进程里按会话开多块屏」═══
 *
 * 那条路看着更省进程，但撞上 libatspi 的硬约束：`atspi_init()` 是**进程级、一次性**的，
 * 一个进程只能绑一条 AT-SPI 总线；跨总线 `exit+init` 实测会损坏其内部状态
 * （见 `backend/linux/atspi.py` 的 `_BUS_STALE_ERROR` 注释）。两块屏必然两条总线，
 * 所以**两块屏必须两个进程**。这也正是 cc-computer-use 自己的设计假设。
 *
 * ═══ 本插件的做法 ═══
 *
 * 监听 `agent/created`，对**每个 root agent** 在它自己的 `agent.ctx` 上挂一份
 * `@deepseek-ai/dsh-mcp-client`。`agent.ctx` 是 agent-local 的作用域：
 *
 *   - 工具经 `ctx.tools.register` 注册成 **scope-local**（DSH 的 `NamedEntries` 报错文案
 *     原话：「for a per-agent variant, register through that agent's `agent.ctx` instead」），
 *     所以多个 agent 用同一个 `serverName` 不冲突；
 *   - 插件随 agent 销毁自动回卷（`agent.ctx` 文档：「its contributions are agent-local,
 *     unwind on disposal」），于是 MCP 子进程退出，它起的 Xephyr 由 cc-computer-use 的
 *     atexit 回收 —— 不留下孤儿屏。
 *
 * ═══ 为什么只挂 root agent ═══
 *
 * subagent（`parentAgent !== undefined`）与主 agent 是同一个任务的两只手，本就该在同一块
 * 屏上协作（串行由 cc-computer-use 的屏锁保证）。而 DSH 的工具视图沿 **scope 祖先链**
 * 继承（`ToolRuntime.view` → `chainLayers`：全局层 + 祖先链每一层），所以 subagent
 * 自动看到父 agent 挂的这批工具，不需要、也不应该再起一个进程 —— 否则会多出一块
 * 没有任何 agent 使用的屏。
 *
 * @module @local/dsh-cc-computer-use-mcp
 */

import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/** Loader 行 id，同时也是本插件自己的稳定名字。 */
export const name = 'cc-cu-per-agent'

/**
 * 不需要任何服务：本插件只挂事件监听，真正的 `tools` 依赖由被挂载的 mcp-client 自己声明
 * （它的 `inject = ['tools']`）。此处若也声明 `tools`，只会让本插件在 tools 就绪前
 * 不激活 —— 而那样反而收不到早期的 `agent/created`。
 */
export const inject = []

/**
 * 该 agent 是不是「子会话」——子会话不单独起沙箱（见模块头注释「为什么只挂 root agent」）。
 *
 * 三条判据都用上，因为它们在**不同 DSH 版本/不同创建路径**下的可用性不同：
 *   1. `agent.parentAgent`：`Agent` 运行时是否暴露这个字段随版本而变（类型上它只出现在
 *      CreateAgentOptions / ResumeAgentOptions 里），有就最直接；
 *   2. `session.header.origin === 'subagent'`：durable 元数据，类型保证存在，是主判据；
 *   3. `delegationDepth > 0`：持久化的递归深度，对「恢复出来的子会话」也成立。
 *
 * 任一条成立即视为子会话。三者都答否 = root 会话，给它一块自己的屏。
 *
 * @param agent - `agent/created` 事件里的 agent。
 * @returns 是否应**跳过**独立沙箱的挂载。
 */
function isSubagent(agent) {
  if (agent.parentAgent !== undefined) return true
  const header = agent.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * 组装交给 mcp-client 的 stdio 配置。
 *
 * 只拷**显式给出**的字段，其余交给 mcp-client 自己的 Config schema 填默认值：把
 * `undefined` 显式塞进去会让 schemastery 的 default 不生效，而默认值（如
 * `toolCallTimeoutMs`）正是它契约的一部分。
 *
 * @param config - 本插件的行配置（字段与 mcp-client 的 stdio 分支同名，便于直接抄）。
 * @returns mcp-client 的 stdio 配置对象。
 */
function stdioConfig(config) {
  const source = config ?? {}
  const out = {
    transport: 'stdio',
    serverName: source.serverName ?? 'cc-computer-use',
    command: source.command,
    args: source.args ?? [],
    env: source.env ?? {},
  }
  // 这三个是可选的：给了才传，没给让 schema 用默认值
  if (source.toolCallTimeoutMs !== undefined) out.toolCallTimeoutMs = source.toolCallTimeoutMs
  if (source.failOnStartupError !== undefined) out.failOnStartupError = source.failOnStartupError
  if (source.reconnect !== undefined) out.reconnect = source.reconnect
  return out
}

/**
 * 挂载入口。
 *
 * @param ctx - 本 bundle 行所在的作用域（profile/host 层）。
 * @param config - 见 cordis.patch.yml；字段与 mcp-client 的 stdio 配置同名。
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  ctx.on('agent/created', ({ agent }) => {
    // root agent 才拥有独立沙箱；subagent 经 scope 祖先链共享父会话那一块（见模块头注释）
    if (isSubagent(agent)) return

    // ⚠️ 这里**不能**用「try 包住 ctx.plugin」了事：Cordis 的 `ctx.plugin()` 返回
    // `Fiber & PromiseLike<Fiber>` —— 启动失败（spawn 失败、initialize 超时、Config 校验
    // 失败）是**异步 reject**，try/catch 抓不到它，会变成 unhandled rejection（Node 默认
    // 打印告警，某些启动参数下直接终止进程）。所以显式接住 thenable。
    //
    // 为什么不 await：`agent/created` 是 serial 监听器，await 会把「创建会话」拖慢到
    // MCP server 冷启动完成（PyInstaller 产物 1~2s）。挂载失败只影响这个会话的隔离屏
    // 工具，不该成为会话创建的阻塞项 —— failOnStartupError 也据此配成 false。
    const mounting = (() => {
      try {
        return agent.ctx.plugin(McpClient, stdioConfig(config))
      } catch (error) {
        // 同步抛（Config 校验、agent.ctx 已 reject 注册）走这里
        logger.error?.(`cc-cu-per-agent: 为会话挂载 cc-computer-use 失败（该会话将没有隔离屏工具）: ${String(error)}`)
        return undefined
      }
    })()

    if (mounting !== undefined) {
      Promise.resolve(mounting).catch((error) => {
        logger.error?.(`cc-cu-per-agent: cc-computer-use 连接未就绪，该会话的隔离屏工具不可用: ${String(error)}`)
      })
    }
  })
}
