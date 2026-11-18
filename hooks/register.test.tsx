import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { dominant, dropExpired, occupy, type Occupancy } from './register'

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

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// The mod draws one frame a second, on the test's clock. The returned call lets the entries settle for a few
// milliseconds, so the last state of the test holds the second, then runs it out.
const frames = (on: On) => {
  const clock = mock.clock(on)
  return async () => {
    await pause(60)
    await clock.advance(1000)
  }
}

test('the spinner lists every running item, latest start first', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('⏳ Agent Ns · audit ⏳ Agent Ns · digest 🦉 Bash Ns · build')

  release()
  await running
})

test('a Skill call shows the skill it loaded', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Skill', skill: 'engineering:writing-code', args: 'ignored' })

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Skill done Ns ago · engineering:writing-code')
})

test('an agent notification delivered into a running turn clears the agent', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))

  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })
  await $.session.append(notification('a1'))

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Agent done Ns ago · digest')
})

test('while the model thinks, its own word leads the background items', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))
  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })

  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'thinking' } })
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('Working ⏳ Agent Ns · digest')
})

test('a spinner text too long for the viewport goes in a card under the engine row, a short one rewrites the message', async ($, on) => {
  const nextFrame = frames(on)
  let message: unknown
  on('ui.render', ($, e) => {
    message = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  await nextFrame()
  const drawnAt = async (columns: number) => {
    const ui = await $.ui.mount({ ...SPINNER, viewport: { columns, rows: 40 } })
    const card = await ui.find({ type: 'Box' })
    await ui.unmount()
    return { card, message }
  }
  const wide = await drawnAt(200)
  expect(wide.card).toBeUndefined()
  expect(String(wide.message).replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Bash done Ns ago · build the whole project')

  const narrow = await drawnAt(40)
  expect(narrow.message).toBeNull()
  expect(narrow.card?.text.replace(/\d+s/g, 'Ns')).toBe('engine🦉 ✓ Bash done Ns ago · build the whole project')
})

// The engine refuses a drawing that holds its own node under a Box with one of these props, and skips the hook.
const REFUSED_ABOVE_ENGINE_ROW = [
  'display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom',
]

test('a wrapped spinner keeps sizing and positioning props off every Box above the engine row', async ($, on) => {
  const nextFrame = frames(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, viewport: { columns: 40, rows: 40 } })
  const boxes = (await ui.findAll({ type: 'Box' })).filter(box => box.text.includes('engine'))
  await ui.unmount()
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(Object.keys(box.props ?? {}).filter(prop => REFUSED_ABOVE_ENGINE_ROW.includes(prop))).toEqual([])
  }
})

const COMPACT = { command: 'compact', args: '' } as CommandRunInput

test('on VS Code the spinner stays the engine\'s own, with its word unchanged', async ($, on) => {
  const nextFrame = frames(on)
  let seen: unknown
  on('ui.render', ($, e) => {
    seen = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  const boxes = await ui.findAll({ type: 'Box' })
  await ui.unmount()
  expect(seen).toBeNull()
  expect(boxes).toEqual([])
})

test('once a VS Code spinner has drawn, the status line carries the running items', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟢 BASH done Ns ago · build the whole project')
})

test('on VS Code the status line keeps the running items while a turn is in progress', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟠 BASH Ns · build the whole project')

  release()
  await running
})

test('on VS Code a compaction shows in the status line', async ($, on) => {
  const nextFrame = frames(on)
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
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const compacting = $.command.run(COMPACT)
  await pause()
  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟠 Compacting conversation · Ns')

  release()
  await compacting
  await nextFrame()
  expect(status).toBeUndefined()
})

test('on the terminal the text stays under a wrapped engine row', async ($, on) => {
  const nextFrame = frames(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build the whole project' })

  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, viewport: { columns: 40, rows: 40 } })
  const boxes = await ui.findAll({ type: 'Box' })
  await ui.unmount()
  expect(boxes.find(box => box.props?.flexWrap === 'wrap')).toBeUndefined()
  expect(boxes[0]?.props.flexDirection).toBe('column')
})

test('the spinner says Compacting while a compaction runs, then goes back to the engine', async ($, on) => {
  const nextFrame = frames(on)
  let drawn: unknown
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = e.props.message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })

  const compacting = $.command.run(COMPACT)
  await pause()
  let ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'requesting' } })
  await ui.unmount()
  expect(String(drawn).replace(/\d+s/g, 'Ns')).toBe('Compacting conversation 🦉 Ns')

  release()
  await compacting
  await nextFrame()
  ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn).toBeNull()
})

const compactingSpinner = (surface: 'terminal' | 'vscode', message: string | null) =>
  ({ ...SPINNER, surface, props: { ...SPINNER.props, message } }) as const

test('a compaction that only the spinner reports shows in the status line until the spinner stops saying so', async ($, on) => {
  const nextFrame = frames(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const compacting = await $.ui.mount(compactingSpinner('vscode', 'Compacting'))
  await compacting.unmount()
  await nextFrame()
  expect(statuses.at(-1)?.replace(/\d+s/g, 'Ns')).toBe('🟠 Compacting conversation · Ns')

  const done = await $.ui.mount(compactingSpinner('vscode', null))
  await done.unmount()
  await nextFrame()
  expect(statuses.at(-1)).toBeUndefined()
})

test('on the terminal the spinner text the engine draws for a compaction is replaced by the one with the clock', async ($, on) => {
  const nextFrame = frames(on)
  let drawn: unknown
  on('ui.render', ($, e) => {
    drawn = (e.props as { message?: unknown }).message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount(compactingSpinner('terminal', 'Compacting conversation'))
  await ui.unmount()
  await nextFrame()
  const again = await $.ui.mount(compactingSpinner('terminal', 'Compacting conversation'))
  await again.unmount()
  expect(String(drawn).replace(/\d+s/g, 'Ns')).toBe('Compacting conversation 🦉 Ns')
})

test('a spinner that said compacting and is not drawn again does not keep the compaction on after the command ends', async ($, on) => {
  const nextFrame = frames(on)
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
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })

  const running = $.command.run(COMPACT)
  await pause()
  const ui = await $.ui.mount(compactingSpinner('vscode', 'Compacting'))
  await ui.unmount()

  release()
  await running
  await nextFrame()
  expect(status).toBeUndefined()
})

test('a spinner that said compacting does not keep the compaction on after the turn completes', async ($, on) => {
  const nextFrame = frames(on)
  let status: string | undefined
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.complete', () => ({ text: '' }))

  const ui = await $.ui.mount(compactingSpinner('vscode', 'Compacting'))
  await ui.unmount()
  expect(status).toBeDefined()

  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  await nextFrame()
  expect(status).toBeUndefined()
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
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash Ns · test ↓1.5k 🦉 Bash Ns · build ↓1.5k')

  release()
  await Promise.all([first, second])
})

test('a call the model did not issue shows no token count', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_none' })

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Bash done Ns ago · build')
})

test('an agent shows its own requests: the latest context plus everything it generated', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Agent Ns · digest Σ23k')

  release()
  await running
})

const answer = (e: { turnId: string; index: number }) =>
  ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(0) }) as const

test('an Agent issued in the same request neither dilutes a sibling call nor shows the request count', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash Ns · test ↓1.5k 🦉 Agent Ns · digest')

  release()
  await Promise.all([agent, bash])
})

test('a background agent keeps counting its requests after its launch returned', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('⏳ Agent Ns · digest Σ21k')
})

test("a subagent's tool call shows the output tokens of the subagent's request", async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash (subagent) Ns · list ↓300')

  release()
  await running
})

test('a count rounds up to two digits, carrying 9,950 over to 10k', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_a', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(9_950) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  const running = $.tool.call({ tool: 'Bash', command: 'make', description: 'build', tool_use_id: 'toolu_a' })
  await pause()

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash Ns · build ↓10k')

  release()
  await running
})

test('the VS Code status line gives each summary an equal share of what the two rows have left', async ($, on) => {
  const nextFrame = frames(on)
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
  await nextFrame()
  const text = status?.replace(/\d+s/g, 'Ns')
  expect(text).toBe(`🟠 BASH Ns · ${'b'.repeat(80)}… ┃ 🟠 BASH Ns · ${'a'.repeat(80)}…`)
  expect(text?.length).toBe(206 - 15)

  release()
  await Promise.all([first, second])
})

test('a short summary hands its spare room to the long one', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe(`🟠 BASH Ns · ${'l'.repeat(156)}… ┃ 🟠 BASH Ns · short`)

  release()
  await Promise.all([first, second])
})

test('the VS Code status line puts the token count after the summary', async ($, on) => {
  const nextFrame = frames(on)
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

  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('🟢 BASH done Ns ago · build ↓1.5k')
})

test('an empty description does not hide the command', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make test', description: '' })

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Bash done Ns ago · make test')
})

test('a background task whose notification never came is dropped after six hours', () => {
  const hour = 3_600_000
  const tasks = new Map([['old', { startedAt: 0 }], ['recent', { startedAt: 2 * hour }]])
  dropExpired(tasks, 6 * hour)
  expect([...tasks.keys()]).toEqual(['old', 'recent'])
  dropExpired(tasks, 6 * hour + 1)
  expect([...tasks.keys()]).toEqual(['recent'])
  dropExpired(tasks, 8 * hour + 1)
  expect(tasks.size).toBe(0)
})

test('the token counts of requests nobody claimed are forgotten once newer ones pile up', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* (_, e) {
    for (let index = 0; index < 300; index++) yield { kind: 'tool', index, id: `toolu_${index}`, name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(1500) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  await drain($.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 }))
  const oldest = $.tool.call({ tool: 'Bash', command: 'make', description: 'oldest', tool_use_id: 'toolu_0' })
  await pause()
  const newest = $.tool.call({ tool: 'Bash', command: 'make', description: 'newest', tool_use_id: 'toolu_299' })
  await pause()

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash Ns · newest ↓1.5k 🦉 Bash Ns · oldest')

  release()
  await Promise.all([oldest, newest])
})

test('the totals of subagents that finished long ago are forgotten once newer ones pile up', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: e.description === 'oldest' ? 'sub0' : 'sub299' }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'stop', stopReason: 'tool_use', usage: usage(100, 1000) }
    return answer(e)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  for (let index = 0; index < 300; index++) {
    await drain($.turn.step({ turnId: `t${index}`, index: 0, model: 'm', messageCount: 1, agentId: `sub${index}` }))
  }
  const oldest = $.tool.call({ tool: 'Agent', description: 'oldest', prompt: 'p', tool_use_id: 'toolu_a' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'oldest', tool_use_id: 'toolu_a' } as never)
  const newest = $.tool.call({ tool: 'Agent', description: 'newest', prompt: 'p', tool_use_id: 'toolu_b' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'newest', tool_use_id: 'toolu_b' } as never)

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Agent Ns · newest Σ1.1k 🦉 Agent Ns · oldest')

  release()
  await Promise.all([oldest, newest])
})

// An agent's request issuing one tool call, its input streamed in pieces.
const toolRequest = async function* (e: { turnId: string; index: number }, name: string, ...json: string[]) {
  yield { kind: 'tool', index: 0, id: `toolu_${e.index}`, name } as const
  for (const piece of json) yield { kind: 'input', index: 0, json: piece } as const
  yield { kind: 'stop', stopReason: 'tool_use', usage: usage(100, 1000) } as const
  return answer(e)
}

test('an agent shows how many tools it has called and the latest one', async ($, on) => {
  const nextFrame = frames(on)
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
    return yield* e.index === 0
      ? toolRequest(e, 'Bash', '{"command":"ls",', '"description":"list files"}')
      : toolRequest(e, 'Read', '{"file_path":"/a.py"}')
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Agent Ns · 2 tools · digest 🦉 Read: /a.py Σ1.2k')

  release()
  await running
})

test('with the owl option off an agent keeps the ▸ before its latest tool', { options: { show_owl: false } }, async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String((e.props as { message?: unknown }).message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('turn.step', async function* (_, e) {
    return yield* e.index === 0
      ? toolRequest(e, 'Bash', '{"command":"ls",', '"description":"list files"}')
      : toolRequest(e, 'Read', '{"file_path":"/a.py"}')
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

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('▶ Agent Ns · 2 tools · digest ▸ Read: /a.py Σ1.2k')

  release()
  await running
})

test("a tool call inside an agent with its own entry shows there, not as an entry of its own", async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  const agent = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'digest', tool_use_id: 'toolu_ag' } as never)
  const inside = $.tool.call({ tool: 'Bash', command: 'ls', description: 'list', tool_use_id: 'toolu_in', agentId: 'sub1' })
  await pause()

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Agent Ns · digest')

  release()
  await Promise.all([agent, inside])
})

test('a tool whose input never arrives shows by name', async ($, on) => {
  const nextFrame = frames(on)
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
    return yield* toolRequest(e, 'Bash')
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  const running = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'digest', tool_use_id: 'toolu_ag' } as never)
  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))
  release()
  await running

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 ✓ Agent done Ns ago · 1 tool · digest 🦉 Bash Σ1.1k')
})

test('on VS Code the tool count follows the clock and the summary and the latest tool share the room', async ($, on) => {
  const nextFrame = frames(on)
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
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('turn.step', async function* (_, e) {
    return yield* toolRequest(e, 'Bash', `{"description":"${'a'.repeat(300)}"}`)
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const running = $.tool.call({ tool: 'Agent', description: 'd'.repeat(300), prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'd'.repeat(300), tool_use_id: 'toolu_ag' } as never)
  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))
  release()
  await running

  await nextFrame()
  const text = status?.replace(/\d+s/g, 'Ns') ?? ''
  expect(text).toMatch(/^🟢 AGENT done Ns ago · 1 tool · d{40,}… ▸ Bash: a{40,}… Σ1\.1k$/)
  // Two rows of 64 reported columns hold 206 characters, 15 of them the panel's prefix.
  expect(text.length).toBeLessThanOrEqual(206 - 15)
})

test('a background agent keeps its tool count and latest tool after its launch returned, and hides its inner calls', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let releaseLaunch!: () => void
  let releaseInner!: () => void
  const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
  const innerGate = new Promise<void>(resolve => { releaseInner = resolve })
  on('ui.render', ($, e) => {
    drawn = String(e.props.message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  on('turn.step', async function* (_, e) {
    return yield* toolRequest(e, 'Bash', '{"description":"list files"}')
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') {
      await launchGate
      return { result: { status: 'async_launched', agentId: 'sub1' } }
    }
    await innerGate
    return { result: {} }
  })

  const launching = $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p', tool_use_id: 'toolu_ag' })
  await pause()
  await $.agent.spawn({ prompt: 'p', description: 'digest', tool_use_id: 'toolu_ag' } as never)
  releaseLaunch()
  await launching
  await drain($.turn.step({ turnId: 'sub-t', index: 0, model: 'm', messageCount: 1, agentId: 'sub1' }))
  const inside = $.tool.call({ tool: 'Bash', command: 'ls', description: 'list files', tool_use_id: 'toolu_in', agentId: 'sub1' })
  await pause()

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('⏳ Agent Ns · 1 tool · digest 🦉 Bash: list files Σ1.1k')

  releaseInner()
  await inside
})

test('with the owl option off the spinner has no owl', { options: { show_owl: false } }, async ($, on) => {
  const nextFrame = frames(on)
  let message: unknown
  on('ui.render', ($, e) => {
    message = (e.props as { message?: unknown }).message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))
  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })

  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'thinking' } })
  await ui.unmount()
  expect(String(message).replace(/\d+s/g, 'Ns')).toBe('Working │ ▶ ⏳ Agent Ns · digest')
})

test('the owl does not read the text it follows: after an emoji in a summary it still shows', async ($, on) => {
  const nextFrame = frames(on)
  let drawn = ''
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = String((e.props as { message?: unknown }).message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })

  const oldest = $.tool.call({ tool: 'Bash', command: 'make', description: 'older' })
  await pause()
  const newest = $.tool.call({ tool: 'Bash', command: 'make', description: 'ship it 🚀' })
  await pause()

  await nextFrame()
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(drawn.replace(/\d+s/g, 'Ns')).toBe('🦉 Bash Ns · ship it 🚀 🦉 Bash Ns · older')

  release()
  await Promise.all([oldest, newest])
})

test('with the owl option off a compaction keeps its dot', { options: { show_owl: false } }, async ($, on) => {
  const nextFrame = frames(on)
  let drawn: unknown
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.render', ($, e) => {
    drawn = (e.props as { message?: unknown }).message
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })

  const compacting = $.command.run(COMPACT)
  await pause()
  await nextFrame()
  const ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, mode: 'requesting' } })
  await ui.unmount()
  expect(String(drawn).replace(/\d+s/g, 'Ns')).toBe('Compacting conversation · Ns')

  release()
  await compacting
})

test('on the terminal a compaction with no turn running shows in the status line, the owl in place of the dot', async ($, on) => {
  const nextFrame = frames(on)
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
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()

  const compacting = $.command.run(COMPACT)
  await pause()
  await nextFrame()
  expect(status?.replace(/\d+s/g, 'Ns')).toBe('Compacting conversation 🦉 Ns')

  release()
  await compacting
})

// Who held each position of the list, one pair of entry and milliseconds per holder.
const held = (...positions: [number, number][][]): Occupancy => positions.map(holders => new Map(holders))

test('the milliseconds of each state go to the entries in the positions they held', () => {
  const occupancy: Occupancy = []
  occupy(occupancy, [5, 4], 200)
  occupy(occupancy, [4], 100)
  expect(occupancy.map(holders => [...holders])).toEqual([[[5, 200], [4, 100]], [[4, 200]]])
})

test('each position shows the entry that held it longest, the newest when tied', () => {
  expect(dominant(held([[1, 300], [2, 700]]), 1000)).toEqual([2])
  expect(dominant(held([[1, 500], [2, 500]]), 1000)).toEqual([2])
})

test('a call that comes and goes within the second does not show, a long one pushes the others down', () => {
  const quick: Occupancy = []
  occupy(quick, [1], 800)
  occupy(quick, [2, 1], 200)
  expect(dominant(quick, 1000)).toEqual([1])

  const long: Occupancy = []
  occupy(long, [1], 400)
  occupy(long, [2, 1], 600)
  expect(dominant(long, 1000)).toEqual([2, 1])
})

test('a position empty for longer than any entry held it shows nothing, half the second is enough to show', () => {
  expect(dominant(held([[1, 1000]], [[2, 300]]), 1000)).toEqual([1])
  expect(dominant(held([[1, 1000]], [[2, 500]]), 1000)).toEqual([1, 2])
})

test('an entry that leads one position is not shown again in the next', () => {
  const positions = held([[1, 450], [2, 300], [3, 250]], [[1, 300], [2, 250], [3, 250]])
  expect(dominant(positions, 1000)).toEqual([1, 3])
})

test('the status changes once a second: calls inside it draw nothing, the tick draws what held it', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') await gate
    return { result: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const long = $.tool.call({ tool: 'Bash', command: 'make', description: 'long' })
  await pause()
  expect(statuses.length).toBe(1)
  await $.tool.call({ tool: 'Skill', skill: 'quick-one' })
  await $.tool.call({ tool: 'Skill', skill: 'quick-two' })
  expect(statuses.length).toBe(1)

  await pause(60)
  await clock.advance(1000)
  expect(statuses.length).toBe(2)
  expect(statuses[1]?.replace(/\d+s/g, 'Ns')).toBe('🟠 BASH Ns · long')

  release()
  await long
})

test('the line goes idle at the next tick, not when the work ends', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.run', { command: 'compact' }, async () => {
    await gate
    return { text: '' }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const compacting = $.command.run(COMPACT)
  await pause()
  release()
  await compacting
  expect(statuses.length).toBe(1)

  await clock.advance(1000)
  expect(statuses.length).toBe(2)
  expect(statuses[1]).toBeUndefined()
})

test('the terminal spinner holds its clocks between ticks and moves them all at the tick', async ($, on) => {
  const clock = mock.clock(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String((e.props as { message?: unknown }).message)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build' })
  await pause(60)
  await clock.advance(1000)

  const draw = async () => {
    const mounted = await $.ui.mount(SPINNER)
    await mounted.unmount()
    return drawn
  }
  const first = await draw()
  await pause(1100)
  expect(await draw()).toBe(first)

  await clock.advance(1000)
  expect(await draw()).not.toBe(first)
})

test('a turn starting or ending while the line ticks changes at once whether the status line may show it', async ($, on) => {
  mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1' } }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Agent', description: 'digest', prompt: 'p' })
  expect(statuses.length).toBe(1)
  expect(statuses[0]).toBeDefined()

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(statuses.length).toBe(2)
  expect(statuses[1]).toBeUndefined()

  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(statuses.length).toBe(3)
  expect(statuses[2]).toContain('digest')
})

test('the ticker stops once the line is idle and the next busy period draws at once and ticks again', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.run', { command: 'compact' }, () => ({ text: '' }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  await $.command.run(COMPACT)
  expect(statuses.length).toBe(1)
  await clock.advance(1000)
  expect(statuses.length).toBe(2)
  expect(statuses[1]).toBeUndefined()

  await $.command.run(COMPACT)
  expect(statuses.length).toBe(3)
  expect(statuses[2]).toBeDefined()
  await clock.advance(1000)
  expect(statuses.length).toBe(4)
  expect(statuses[3]).toBeUndefined()
})

test('each second starts from nothing: an entry that held the last one is not carried into the next', async ($, on) => {
  const clock = mock.clock(on)
  let status: string | undefined
  const gates: Record<string, () => void> = {}
  const held = (command: string) => new Promise<void>(resolve => { gates[command] = resolve })
  const waits = { old: held('old'), young: held('young') }
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', async (_, e) => {
    await waits[String((e as { command?: unknown }).command) as 'old' | 'young']
    return { result: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'vscode' })
  await ui.unmount()

  const old = $.tool.call({ tool: 'Bash', command: 'old', description: 'the old one' })
  await pause(120)
  await clock.advance(1000)
  expect(status).toContain('the old one')

  gates.old?.()
  await old
  const young = $.tool.call({ tool: 'Bash', command: 'young', description: 'the young one' })
  await pause(60)
  await clock.advance(1000)
  expect(status).toContain('the young one')
  expect(status).not.toContain('the old one')

  gates.young?.()
  await young
})
