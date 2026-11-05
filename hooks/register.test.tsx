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
