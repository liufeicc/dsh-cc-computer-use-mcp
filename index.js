/**
 * 每个 root agent 一份 cc-computer-use MCP 进程 —— 让并发的多个会话各有一块隔离屏，
 * 并且**由工作区开关决定挂不挂**。
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
 * ═══ 2026-10-23 追加：挂载由「工作区选择」决定 ═══
 *
 * 上面那种 scope-local 挂法有个副作用：工具在全局口径里看不见，于是
 * `@local/dsh-mcp-workspace-policy` 的 MCP 菜单**列不出它**，开关也管不到它
 * （`restrict({deny})` 的契约是「scoped registrations remain visible」）。
 * 现在两条路接上：
 *
 *   1. 本插件加载时向策略服务 `declarePerAgent({ name })` 声明自己，菜单因此能列出它；
 *   2. 挂不挂由该工作区是否勾选它决定（`selectedFor(cwd).includes(serverName)`）——
 *      未勾选就**连进程都不起**（省的不只是 token，还有一整块 Xephyr 与 AT-SPI 总线）；
 *      勾选变化时对本工作区的活会话就地挂载/卸载（监听 `mcp-workspace/changed`）。
 *
 * 策略服务不在（没装策略包、或它的旧版本没有声明接口）时**退回旧行为：照常挂载**
 * （fail open）—— 不能因为策略缺失把用户的工具干掉。
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
 *
 * 策略服务同理，用 `ctx.inject(['mcpWorkspace'], …)` 做**可选**依赖（见 apply）：
 * 声明要有它，但没它也得能工作。
 */
export const inject = []

/**
 * 「某个工作区的选择变了」事件名。
 *
 * 与 `@local/dsh-mcp-workspace-policy` 的 `PER_AGENT_EVENT` 是同一个字面量。
 * 刻意**不 import 那个包**：本包不依赖策略包也必须能独立加载（没装策略时退回旧行为）。
 */
const PER_AGENT_EVENT = 'mcp-workspace/changed'

/** 默认 server 名（与 cordis.patch.yml 的 serverName 一致）。 */
const DEFAULT_SERVER_NAME = 'cc-computer-use'

/**
 * 挂载所有权的标记键。
 *
 * 用 `Symbol.for` 而不是模块级 Map：插件被热重载时模块会重新求值、模块级状态清空，
 * 但旧实例挂在 `agent.ctx` 上的 fiber **不会**随本插件卸载（它属于 agent 作用域）。
 * 若不认领，新实例会再挂一份 → `mcp-client` 的 serverName 占用检查直接抛
 * "already in use"，而旧进程还活着 —— 既占资源又难查。把 fiber 挂在 agent 对象上，
 * 重载后就能认领回来（或按最新选择卸掉）。
 */
const MOUNT_KEY = Symbol.for('dsh-cc-computer-use-mcp/mounted-fiber')

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
 * 读一个 agent 的工作目录。
 *
 * 必须与工作区选择器用的字符串**完全一致**（都是绝对路径）：策略服务按
 * `session.header.cwd` 作键，界面上勾选时传的是工作区路径。
 *
 * @param agent - 目标 agent。
 * @returns 绝对路径，缺失或读不到时 `undefined`。
 */
function cwdOf(agent) {
  try {
    const cwd = agent.session === undefined ? undefined : agent.session.header.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
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
    serverName: source.serverName ?? DEFAULT_SERVER_NAME,
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
  /** 服务名，同时决定模型看到的工具前缀 `mcp__<serverName>__`。 */
  const serverName = (config !== null && typeof config === 'object' && config.serverName) || DEFAULT_SERVER_NAME

  /** agentId → `{ agent, fiber }`：本实例认为「已挂载」的会话。 */
  const mounted = new Map()

  /**
   * 惰性取策略服务。
   *
   * 每次调用都重新 `ctx.get`：本插件与策略行谁先加载不确定（策略还可能在运行中
   * 被热重载），缓存引用会拿到已销毁的旧实例。
   *
   * @returns 策略服务，或 `null`（没装/旧版本/尚未挂上）。
   */
  function policy() {
    let service
    try {
      service = ctx.get('mcpWorkspace')
    } catch {
      service = undefined
    }
    return service !== undefined && service !== null && typeof service.selectedFor === 'function' ? service : null
  }

  /**
   * 该工作区是否勾选了本 server。
   *
   * 策略服务缺席时返回 `true`（fail open，退回 2026-10-21 的行为）；策略在但拿不到
   * cwd 时返回 `false`：没法判断就不起进程，符合「未配置 = 不暴露」的产品决定。
   *
   * @param cwd - 工作区绝对路径。
   * @returns 是否应当挂载。
   */
  function allowed(cwd) {
    const service = policy()
    if (service === null) return true
    if (cwd === undefined) return false
    return service.selectedFor(cwd).includes(serverName)
  }

  /**
   * 认领 agent 身上由**本插件上一个实例**挂的 fiber（热重载语境）。
   *
   * 为什么必须单独一步：`reconcile()` 是"该挂的挂、该卸的卸"，而卸载只看本实例的
   * `mounted` 表。重载后表是空的，若不先认领，取消勾选那一刻就找不到旧 fiber，
   * 旧进程会一直挂着直到会话销毁 —— 既占资源，也让"开关是真的"这句话不成立。
   *
   * @param agent - root agent。
   */
  function adopt(agent) {
    const id = String(agent.id)
    if (mounted.has(id)) return
    const fiber = agent[MOUNT_KEY]
    if (fiber !== undefined) mounted.set(id, { agent, fiber })
  }

  /**
   * 给某个 root agent 挂一份 mcp-client。重复调用是空操作。
   *
   * 认领优先：`agent[MOUNT_KEY]` 上有本插件前一个实例（热重载前）挂的 fiber 时直接接管，
   * 不再挂第二份 —— 见 `MOUNT_KEY` 的注释。
   *
   * @param agent - root agent。
   */
  function mount(agent) {
    const id = String(agent.id)
    if (mounted.has(id)) return
    if (agent.ctx === undefined) return

    adopt(agent)
    if (mounted.has(id)) return

    // ⚠️ 这里**不能**用「try 包住 ctx.plugin」了事：Cordis 的 `ctx.plugin()` 返回
    // `Fiber & PromiseLike<Fiber>` —— 启动失败（spawn 失败、initialize 超时、Config 校验
    // 失败）是**异步 reject**，try/catch 抓不到它，会变成 unhandled rejection（Node 默认
    // 打印告警，某些启动参数下直接终止进程）。所以显式接住 thenable。
    //
    // 为什么不 await：`agent/created` 是 serial 监听器，await 会把「创建会话」拖慢到
    // MCP server 冷启动完成（PyInstaller 产物 1~2s）。挂载失败只影响这个会话的隔离屏
    // 工具，不该成为会话创建的阻塞项 —— failOnStartupError 也据此配成 false。
    let fiber
    try {
      fiber = agent.ctx.plugin(McpClient, stdioConfig(config))
    } catch (error) {
      // 同步抛（Config 校验、agent.ctx 已 reject 注册）走这里
      logger.error?.(`cc-cu-per-agent: 为会话挂载 cc-computer-use 失败（该会话将没有隔离屏工具）: ${String(error)}`)
      return
    }

    try {
      Object.defineProperty(agent, MOUNT_KEY, { configurable: true, writable: true, value: fiber })
    } catch {
      // agent 可能是不可扩展的代理；认领失效不影响本次挂载，只是热重载后可能重挂。
    }
    mounted.set(id, { agent, fiber })

    if (fiber !== undefined) {
      Promise.resolve(fiber).catch((error) => {
        // 启动失败：撤销记录，免得后续 reconcile 以为它还挂着、再也不会重试。
        if (mounted.get(id)?.fiber === fiber) mounted.delete(id)
        logger.error?.(`cc-cu-per-agent: cc-computer-use 连接未就绪，该会话的隔离屏工具不可用: ${String(error)}`)
      })
    }
  }

  /**
   * 卸掉某个 agent 上的 mcp-client。
   *
   * dispose 之后 mcp-client 的 effect 会断开连接、注销工具、释放 serverName 占用，
   * 子进程退出，它起的 Xephyr 由 cc-computer-use 的 atexit 回收。
   *
   * @param agentId - agent id（字符串或数字）。
   */
  function unmount(agentId) {
    const id = String(agentId)
    const record = mounted.get(id)
    if (record === undefined) return
    mounted.delete(id)
    try {
      if (record.agent !== undefined) delete record.agent[MOUNT_KEY]
    } catch {
      /* ignore */
    }
    try {
      void Promise.resolve(record.fiber?.dispose?.()).catch((error) => {
        logger.error?.(`cc-cu-per-agent: 卸载 cc-computer-use 失败: ${String(error)}`)
      })
    } catch (error) {
      logger.error?.(`cc-cu-per-agent: 卸载 cc-computer-use 失败: ${String(error)}`)
    }
  }

  /** 遍历活着的 root agent。 */
  function eachRootAgent(visit) {
    const agents = ctx.get('agents')
    for (const agent of agents === undefined ? [] : agents.list()) {
      if (isSubagent(agent)) continue
      visit(agent)
    }
  }

  /**
   * 让所有活 root agent 与当前选择对齐（启动时、策略晚到时、以及每次变更事件）。
   * @param onlyWorkspace - 只处理这个工作区；省略表示全部。
   */
  function reconcile(onlyWorkspace) {
    eachRootAgent((agent) => {
      const cwd = cwdOf(agent)
      if (onlyWorkspace !== undefined && cwd !== onlyWorkspace) return
      if (cwd === undefined) return
      // 先认领上一个实例留下的 fiber，否则"取消勾选"会找不到要卸的东西（热重载语境）。
      adopt(agent)
      if (allowed(cwd)) mount(agent)
      else unmount(agent.id)
    })
  }

  // ---- 生命周期接线 ----

  // 激活日志：与策略行的那条配对。挂载门控出问题时，先看这两条有没有先后出现 ——
  // 「本行在、策略不在」会 fail open（每个会话都挂），与「策略在、选择为空」完全不同。
  ctx.logger?.info?.(`cc-cu-per-agent: 已激活，serverName=${serverName}（挂载由工作区 MCP 选择决定）`)

  ctx.on('agent/created', ({ agent }) => {
    // root agent 才拥有独立沙箱；subagent 经 scope 祖先链共享父会话那一块（见模块头注释）
    if (isSubagent(agent)) return
    if (!allowed(cwdOf(agent))) return
    mount(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    // fiber 会随 agent.ctx 一起回卷，这里只清账，避免 map 里留死引用。
    mounted.delete(String(agent.id))
  })

  ctx.on(PER_AGENT_EVENT, (payload) => {
    const workspace = payload !== null && typeof payload === 'object' ? payload.workspace : undefined
    if (typeof workspace !== 'string' || workspace === '') return
    reconcile(workspace)
  })

  // 策略服务是**可选**依赖：它一出现就声明自己，并把已有会话对齐一次；
  // 它被卸载/热重载时，这个子 fiber 随之回卷（声明由 disposer 撤销）。
  ctx.inject(['mcpWorkspace'], (scoped) => {
    const service = scoped.get('mcpWorkspace')
    if (service === undefined || service === null || typeof service.declarePerAgent !== 'function') return
    const off = service.declarePerAgent({ name: serverName })
    // 策略可能晚于会话挂上：立刻按它的选择纠正一次（早先按 fail open 挂的会被卸掉）。
    reconcile()
    return () => {
      if (typeof off === 'function') off()
    }
  })

  // agents 服务就绪时补一次：本插件可能晚于已有会话加载（热重载、插件晚装），
  // 那些 agent 不会再有 `agent/created` 事件。
  ctx.inject(['agents'], () => {
    reconcile()
  })
}
