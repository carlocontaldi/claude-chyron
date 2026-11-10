import { expect, test } from 'claude-code/testing'

const SPINNER = {
  plugin: 'full-focus-view',
  component: 'Spinner',
  surface: 'vscode',
  props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' },
} as const

const notification = (taskId: string) => ({
  message: {
    type: 'user',
    content: [{ type: 'text', text: `<task-notification>\n<task-id>${taskId}</task-id>\n</task-notification>` }],
  },
  door: 'queue',
  origin: { kind: 'engine' },
  uuid: `queue-${taskId}`,
}) as const

const pause = () => new Promise(resolve => setTimeout(resolve, 5))

test('the spinner lists every running item, latest start first', async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') await gate
    return { result: e.tool === 'Agent' ? { status: 'async_launched', agentId: e.description } : {} }
  })

  const running = $.tool.call({ tool: 'Bash', command: 'make', description: 'build' })
  await pause()
  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })
  await pause()
  await $.tool.call({ tool: 'Agent', description: 'audit', prompt: 'p' })

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ ⏳ Agent Ns · audit │ ▶ ⏳ Agent Ns · digest │ ▶ Bash Ns · build')

  release()
  await running
})

test('an agent notification delivered into a running turn clears the agent', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))

  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })
  await $.session.append(notification('a1'))

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('✓ Agent done Ns ago · digest')
})

test('while the model thinks, its own word leads the background items', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))
  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })

  const ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'thinking' } })
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('Working │ ▶ ⏳ Agent Ns · digest')
})

test('a spinner text too long for the viewport gets a margin above it, a short one does not', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  const marginAt = async (columns: number) => {
    const ui = await $.ui.mount({ ...SPINNER, viewport: { columns, rows: 40 } })
    const box = await ui.find({ type: 'Box' })
    await ui.unmount()
    return box?.props?.marginTop
  }
  expect(await marginAt(200)).toBeUndefined()
  expect(await marginAt(40)).toBe(1)
})

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] } as const

test('the spinner says Compacting while a compaction runs, then goes back to the engine', async ($, on) => {
  let drawn: unknown
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.compact', async () => {
    await gate
    return { messages: [SUMMARY] }
  })

  const compacting = $.session.compact({ trigger: 'plugin', messages: [SUMMARY] })
  await pause()
  let ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'requesting' } })
  await ui.unmount()
  expect(String(drawn).replace(/\d+s/g, 'Ns')).toBe('Compacting conversation · Ns')

  release()
  await compacting
  ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn).toBeNull()
})

const usage = (output: number, context = 1) => ({
  model: 'm',
  input_tokens: context,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const chunk of stream) void chunk
}

test('a running call shows the output tokens of the request that issued it, not a share', async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'toolu_a', name: 'Bash' }
    yield { kind: 'tool', index: 1, id: 'toolu_b', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(1500) }
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [{ name: 'Bash', input: {} }, { name: 'Bash', input: {} }],
      stopReason: 'tool_use',
      usage: usage(1500),
    }
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  const first = $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_a' })
  await pause()
  const second = $.tool.call({ tool: 'Bash', command: 'make test', description: 'test', tool_use_id: 'toolu_b' })
  await pause()

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash Ns · 1.5k out · test │ ▶ Bash Ns · 1.5k out · build')

  release()
  await Promise.all([first, second])
})

test('a call the model did not issue shows no token count', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_none' })

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('✓ Bash done Ns ago · build')
})

test('an agent shows its own requests: the latest context plus everything it generated', async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('turn.step', async function* (_, e) {
    const used = usage(e.index === 0 ? 400 : 100, e.index === 0 ? 20_000 : 22_000)
    yield { kind: 'stop', stopReason: 'tool_use', usage: used }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: used }
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  const running = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'digest', tool_use_id: 'toolu_ag' } as never)
  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))
  await drain($.turn.step({ turnId: 'sub-t', index: 1, model: 'm', messageCount: 3, agentId: 'sub1' }))

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Agent Ns · 22.5k tok · digest')

  release()
  await running
})

const answer = (e: { turnId: string; index: number }) =>
  ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(0) }) as const

test('an Agent issued in the same request neither dilutes a sibling call nor shows the request count', async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_ag', name: 'Agent' }
    yield { kind: 'tool', index: 1, id: 'toolu_b', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(1500) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  const agent = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  const bash = $.tool.call({ tool: 'Bash', command: 'make test', description: 'test', tool_use_id: 'toolu_b' })
  await pause()

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash Ns · 1.5k out · test │ ▶ Agent Ns · digest')

  release()
  await Promise.all([agent, bash])
})

test('a background agent keeps counting its requests after its launch returned', async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(400, 20_000) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: { status: 'async_launched', agentId: 'sub1' } }
  })

  const launching = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'digest', tool_use_id: 'toolu_ag' } as never)
  release()
  await launching
  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ ⏳ Agent Ns · 20.4k tok · digest')
})

test("a subagent's tool call shows the output tokens of the subagent's request", async ($, on) => {
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_sub', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(300) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))
  const running = $.tool.call({ tool: 'Bash', command: 'ls', description: 'list', tool_use_id: 'toolu_sub', agentId: 'sub1' })
  await pause()

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash (subagent) Ns · 300 out · list')

  release()
  await running
})

const PANE = {
  plugin: 'full-focus-view',
  component: 'Pane',
  requestId: 'live-action',
  surface: 'vscode',
  props: { title: 'Live action', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the /live pane shows the token count on its head and on every other item', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_a', name: 'Bash' }
    yield { kind: 'tool', index: 1, id: 'toolu_b', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(1500) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  const first = $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_a' })
  await pause()
  const second = $.tool.call({ tool: 'Bash', command: 'make test', description: 'test', tool_use_id: 'toolu_b' })
  await pause()

  const ui = await $.ui.mount(PANE)
  const head = await ui.find({ type: 'Text', text: /▶ Bash/ })
  const rest = await ui.find({ type: 'Text', text: /▷ Bash/ })
  await ui.unmount()
  expect(head?.text.replace(/\d+s/g, 'Ns')).toBe('▶ Bash · Ns · 1.5k out')
  expect(rest?.text.replace(/\d+s/g, 'Ns')).toBe('▷ Bash Ns · 1.5k out · build')

  release()
  await Promise.all([first, second])
})
