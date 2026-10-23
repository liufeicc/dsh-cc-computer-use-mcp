/**
 * 挂载门控的离线单测：**由工作区选择决定挂不挂 cc-computer-use**。
 *
 * 这里不启动真的 MCP 进程，也不跑真的 cordis —— 用一个假宿主把 `agent/created`、
 * `mcp-workspace/changed`、`ctx.inject` 三个接缝模拟出来，只验证本插件的判断逻辑：
 *
 *  1. 勾选了的工作区 → 挂；没勾 → **根本不起进程**。
 *  2. 选择变化 → 对活会话立即挂载/卸载（卸载要调 dispose）。
 *  3. 子会话（subagent）永远不单独挂。
 *  4. 策略服务缺席 → fail open（照旧挂载，不能因为策略没装把用户工具干掉）。
 *  5. 插件热重载 → 认领 agent 身上上一个实例挂的 fiber，不重挂第二份；
 *     按最新选择该卸就卸。
 *
 * `agent.ctx.plugin()` 在假宿主里只是一次记录 —— 传进去的 `McpClient` 模块本身不会被调用，
 * 所以不需要真的 mcp-client 能跑（软链存在即可 import 本模块）。
 *
 *   node test/gating.mjs
 */
import assert from 'node:assert/strict'

const { apply } = await import('../index.js')

/** 与 index.js 里同一个 `Symbol.for` 键（跨模块实例稳定，正是它存在的意义）。 */
const MOUNT_KEY = Symbol.for('dsh-cc-computer-use-mcp/mounted-fiber')

const failures = []

/** 断言一条，失败只记录不中断。 */
function check(label, work) {
  try {
    work()
    console.log('ok   ' + label)
  } catch (error) {
    failures.push(label)
    console.log('FAIL ' + label + ' — ' + String(error instanceof Error ? error.message : error))
  }
}

/**
 * 造一个假宿主。
 *
 * @param options.agents - 一开始就活着的 agent（在 apply 之前就存在 = 热重载语境的补挂）。
 * @param options.policy - 假策略服务；传 `null` 模拟"策略没挂上"。
 */
function createHarness(options = {}) {
  const agents = options.agents ?? []
  const handlers = new Map()
  const mounts = []
  const disposed = []
  const errors = []
  const declared = []
  const policy = options.policy === undefined ? createPolicy() : options.policy

  const ctx = {
    logger: { error: (message) => errors.push(String(message)) },
    get(name) {
      if (name === 'mcpWorkspace') return policy === null ? undefined : policy
      if (name === 'agents') return { list: () => agents }
      return undefined
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const current = handlers.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    // 假 inject：依赖已就绪，回调立即跑一次（与 cordis 在依赖满足时的行为一致）
    inject(deps, callback) {
      callback(ctx)
    },
    provide() {},
  }

  /** 造一个 root agent；`cwd` 决定它属于哪个工作区。 */
  function makeAgent(id, cwd, extra = {}) {
    const agent = {
      id,
      session: { header: { cwd } },
      ...extra,
    }
    agent.ctx = {
      plugin(_pluginModule, config) {
        mounts.push({ id, config })
        return { dispose: () => disposed.push(id) }
      },
    }
    return agent
  }

  /** 触发一条事件。 */
  function fire(event, ...args) {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }

  return { ctx, agents, policy, mounts, disposed, errors, declared, makeAgent, fire }
}

/** 假策略服务：只实现本插件用到的 selectedFor / declarePerAgent。 */
function createPolicy() {
  const selection = new Map()
  return {
    /** cwd → 选中的 server 名数组。 */
    selection,
    declared: [],
    selectedFor(cwd) {
      return selection.get(cwd) ?? []
    },
    declarePerAgent(request) {
      this.declared.push(request.name)
      return () => {
        const index = this.declared.indexOf(request.name)
        if (index >= 0) this.declared.splice(index, 1)
      }
    },
  }
}

// ---------------------------------------------------------------- 基本门控

{
  const policy = createPolicy()
  const harness = createHarness({ policy })
  const on = harness.makeAgent('a-on', '/ws/on')
  const off = harness.makeAgent('a-off', '/ws/off')
  harness.agents.push(on, off)
  policy.selection.set('/ws/on', ['cc-computer-use'])

  apply(harness.ctx, { command: '/bin/true', serverName: 'cc-computer-use' })

  check('勾选的工作区：活会话被补挂（热重载/插件晚装的路径）', () => {
    assert.deepEqual(harness.mounts.map((entry) => entry.id), ['a-on'])
  })

  check('未勾选的工作区：根本不起进程', () => {
    assert.equal(harness.mounts.some((entry) => entry.id === 'a-off'), false)
  })

  check('挂载用的是 stdio 配置且 serverName 正确', () => {
    assert.equal(harness.mounts[0].config.transport, 'stdio')
    assert.equal(harness.mounts[0].config.serverName, 'cc-computer-use')
    assert.equal(harness.mounts[0].config.command, '/bin/true')
  })

  check('向策略声明了会话级 server', () => {
    assert.deepEqual(harness.policy.declared, ['cc-computer-use'])
  })

  check('新会话按各自工作区的选择决定挂不挂', () => {
    harness.fire('agent/created', { agent: harness.makeAgent('a-new-off', '/ws/off') })
    harness.fire('agent/created', { agent: harness.makeAgent('a-new-on', '/ws/on') })
    assert.equal(harness.mounts.some((entry) => entry.id === 'a-new-off'), false)
    assert.equal(harness.mounts.some((entry) => entry.id === 'a-new-on'), true)
  })

  check('子会话不单独挂（继承父会话那块屏）', () => {
    const child = harness.makeAgent('a-child', '/ws/on', { session: { header: { cwd: '/ws/on', origin: 'subagent' } } })
    harness.fire('agent/created', { agent: child })
    assert.equal(harness.mounts.some((entry) => entry.id === 'a-child'), false)
  })
}

// ---------------------------------------------------------------- 开关联动

{
  const policy = createPolicy()
  const harness = createHarness({ policy })
  const agent = harness.makeAgent('a1', '/ws/x')
  harness.agents.push(agent)
  policy.selection.set('/ws/x', [])

  apply(harness.ctx, { command: '/bin/true' })

  check('未勾选时不挂', () => {
    assert.equal(harness.mounts.length, 0)
  })

  policy.selection.set('/ws/x', ['cc-computer-use'])
  harness.fire('mcp-workspace/changed', { workspace: '/ws/x', selected: ['cc-computer-use'] })

  check('勾上后对活会话立即挂载', () => {
    assert.equal(harness.mounts.filter((entry) => entry.id === 'a1').length, 1)
  })

  policy.selection.set('/ws/x', [])
  harness.fire('mcp-workspace/changed', { workspace: '/ws/x', selected: [] })

  check('取消勾选后立即 dispose', () => {
    assert.deepEqual(harness.disposed, ['a1'])
  })

  check('卸载后清掉 agent 身上的挂载标记', () => {
    assert.equal(agent[MOUNT_KEY], undefined)
  })

  check('别的 workspace 的事件不影响本会话', () => {
    policy.selection.set('/ws/y', ['cc-computer-use'])
    harness.fire('mcp-workspace/changed', { workspace: '/ws/y', selected: ['cc-computer-use'] })
    assert.equal(harness.mounts.filter((entry) => entry.id === 'a1').length, 1)
  })

  check('载荷不合法的变更事件被忽略（不抛）', () => {
    harness.fire('mcp-workspace/changed', undefined)
    harness.fire('mcp-workspace/changed', { workspace: '' })
  })
}

// ---------------------------------------------------------------- 无策略服务

{
  const harness = createHarness({ policy: null })
  const agent = harness.makeAgent('a1', '/ws/any')
  harness.agents.push(agent)

  apply(harness.ctx, { command: '/bin/true' })

  check('策略服务缺席时 fail open：照常挂载', () => {
    assert.deepEqual(harness.mounts.map((entry) => entry.id), ['a1'])
  })

  check('策略缺席时不声明（没有服务可声明）', () => {
    assert.deepEqual(harness.policy, null)
  })
}

// ---------------------------------------------------------------- 热重载认领

{
  const policy = createPolicy()
  const harness = createHarness({ policy })
  const agent = harness.makeAgent('a1', '/ws/x')
  harness.agents.push(agent)

  /** 上一个插件实例挂在 agent 上的 fiber。 */
  const adopted = { dispose: () => harness.disposed.push('a1') }
  agent[MOUNT_KEY] = adopted
  policy.selection.set('/ws/x', ['cc-computer-use'])

  apply(harness.ctx, { command: '/bin/true' })

  check('热重载后认领旧 fiber，不重挂第二份', () => {
    assert.deepEqual(harness.mounts, [])
    assert.equal(agent[MOUNT_KEY], adopted)
  })

  policy.selection.set('/ws/x', [])
  harness.fire('mcp-workspace/changed', { workspace: '/ws/x', selected: [] })

  check('认领来的 fiber 在取消勾选时也会被卸掉', () => {
    assert.deepEqual(harness.disposed, ['a1'])
    assert.equal(agent[MOUNT_KEY], undefined)
  })
}

// ---------------------------------------------------------------- 热重载 + 已取消勾选

{
  const policy = createPolicy()
  const harness = createHarness({ policy })
  const agent = harness.makeAgent('a1', '/ws/x')
  harness.agents.push(agent)

  /** 上一个实例挂的 fiber，而当前选择已经是"不勾"。 */
  agent[MOUNT_KEY] = { dispose: () => harness.disposed.push('a1') }
  policy.selection.set('/ws/x', [])

  apply(harness.ctx, { command: '/bin/true' })

  check('重载后先认领、再按最新选择卸掉（不重挂也不留孤儿）', () => {
    assert.deepEqual(harness.mounts, [])
    assert.deepEqual(harness.disposed, ['a1'])
    assert.equal(agent[MOUNT_KEY], undefined)
  })
}

console.log('')
if (failures.length === 0) {
  console.log('all checks passed')
} else {
  console.log(failures.length + ' check(s) failed')
  process.exitCode = 1
}
