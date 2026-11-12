import { expect, test } from 'claude-code/testing'

const SPINNER = {
  plugin: 'chyron',
  component: 'Spinner',
  surface: 'terminal',
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

test('a Skill call shows the skill it loaded', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Skill', skill: 'engineering:writing-code', args: 'ignored' })

  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('✓ Skill done Ns ago · engineering:writing-code')
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

test('a spinner text too long for the viewport goes in a card under the engine row, a short one rewrites the message', async ($, on) => {
  let message: unknown
  on('ui.render', ($, e) => {
    message = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  const drawnAt = async (columns: number) => {
    const ui = await $.ui.mount({ ...SPINNER, viewport: { columns, rows: 40 } })
    const card = await ui.find({ type: 'Box' })
    await ui.unmount()
    return { card, message }
  }
  const wide = await drawnAt(200)
  expect(wide.card).toBeUndefined()
  expect(String(wide.message).replace(/\d+s/g, 'Ns')).toBe('✓ Bash done Ns ago · build the whole project')

  const narrow = await drawnAt(40)
  expect(narrow.message).toBeNull()
  expect(narrow.card?.text.replace(/\d+s/g, 'Ns')).toBe('engine✓ Bash done Ns ago · build the whole project')
})

// The engine refuses a drawing that holds its own node under a Box with one of these props, and skips the hook.
const REFUSED_ABOVE_ENGINE_ROW = [
  'display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom',
]

test('a wrapped spinner keeps sizing and positioning props off every Box above the engine row', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  const ui = await $.ui.mount({ ...SPINNER, viewport: { columns: 40, rows: 40 } })
  const boxes = (await ui.findAll({ type: 'Box' })).filter(box => box.text.includes('engine'))
  await ui.unmount()
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(Object.keys(box.props ?? {}).filter(prop => REFUSED_ABOVE_ENGINE_ROW.includes(prop))).toEqual([])
  }
})

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] } as const

test('on VS Code the spinner stays the engine\'s own, with its word unchanged', async ($, on) => {
  let seen: unknown
  on('ui.render', ($, e) => {
    seen = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  const boxes = await ui.findAll({ type: 'Box' })
  await ui.unmount()
  expect(seen).toBeNull()
  expect(boxes).toEqual([])
})

test('once a VS Code spinner has drawn, the status line carries the running items', async ($, on) => {
  let status: string | undefined
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟢 BASH done Ns ago · build the whole project')
})

test('on VS Code the status line keeps the running items while a turn is in progress', async ($, on) => {
  let status: string | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  on('turn.start', () => ({ turnId: 't1' }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  await $.turn.start({ text: 'go', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })
  await pause()

  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟠 BASH Ns · build the whole project')

  release()
  await running
})

test('on VS Code a compaction shows in the status line', async ($, on) => {
  let status: string | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.compact', async () => {
    await gate
    return { messages: [SUMMARY] }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const compacting = $.session.compact({ trigger: 'plugin', messages: [SUMMARY] })
  await pause()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟠 Compacting conversation · Ns')

  release()
  await compacting
})

test('on the terminal the text stays under a wrapped engine row', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  const ui = await $.ui.mount({ ...SPINNER, viewport: { columns: 40, rows: 40 } })
  const boxes = await ui.findAll({ type: 'Box' })
  await ui.unmount()
  expect(boxes.find(box => box.props?.flexWrap === 'wrap')).toBeUndefined()
  expect(boxes[0]?.props.flexDirection).toBe('column')
})

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
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash Ns · test · 1.5k out │ ▶ Bash Ns · build · 1.5k out')

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
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Agent Ns · digest · 22.5k tok')

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
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash Ns · test · 1.5k out │ ▶ Agent Ns · digest')

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
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ ⏳ Agent Ns · digest · 20.4k tok')
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
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Bash (subagent) Ns · list · 300 out')

  release()
  await running
})

test('the VS Code status line gives each summary an equal share of what the two rows have left', async ($, on) => {
  let status: string | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const first = $.tool.call({ tool: 'Bash', command: 'a', description: 'a'.repeat(300) })
  await pause()
  const second = $.tool.call({ tool: 'Bash', command: 'b', description: 'b'.repeat(300) })
  await pause()

  // Two rows of 64 reported columns hold 64 * 1.7 * 2 * 0.95 = 206 characters, 15 of them the panel's prefix.
  // The two heads and their separator take 29, which leaves 162 to share: 81 each.
  const text = status?.replace(/\d+s/g, 'Ns')
  expect(text).toBe(`🟠 BASH Ns · ${'b'.repeat(80)}… ┃ 🟠 BASH Ns · ${'a'.repeat(80)}…`)
  expect(text?.length).toBe(206 - 15)

  release()
  await Promise.all([first, second])
})

test('a short summary hands its spare room to the long one', async ($, on) => {
  let status: string | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const first = $.tool.call({ tool: 'Bash', command: 's', description: 'short' })
  await pause()
  const second = $.tool.call({ tool: 'Bash', command: 'l', description: 'l'.repeat(300) })
  await pause()

  expect(status?.replace(/\d+s/g, 'Ns')).toBe(`🟠 BASH Ns · ${'l'.repeat(156)}… ┃ 🟠 BASH Ns · short`)

  release()
  await Promise.all([first, second])
})

test('the VS Code status line puts the token count after the summary', async ($, on) => {
  let status: string | undefined
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_a', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(1500) }
    return answer(e)
  })
  on('tool.call', () => ({ result: {} }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_a' })

  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟢 BASH done Ns ago · build · 1.5k out')
})
