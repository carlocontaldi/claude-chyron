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
