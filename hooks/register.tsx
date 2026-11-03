import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'live-action'
const STATUS_WIDTH = 100
const BODY_LIMIT = 3000
const TICK_MS = 1000
const HOLD_MS = 30_000
const TURN_HOLD_MS = 600_000

type Call = {
  tool: string
  input: Record<string, unknown>
  startedAt: number
  isSubagent: boolean
}
type Item = {
  label: string
  summary: string
  description?: string
  body?: string
  language?: string
  startedAt: number
  endedAt?: number
}

const calls = new Map<string, Call>()
const backgrounds = new Map<string, Call>()
let last: (Call & { endedAt: number }) | undefined
let isTurn = false
let isIdle = false
let ticker: Timer | undefined
let isOpen = false

const oneLine = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

const headline = (input: Record<string, unknown>) =>
  oneLine(
    String(
      input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ??
        input.query ?? input.prompt ?? '',
    ),
    STATUS_WIDTH,
  )

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`

const clock = ({ startedAt, endedAt }: Item) =>
  endedAt === undefined ? seconds(Date.now() - startedAt) : `done ${seconds(Date.now() - endedAt)} ago`

const inputOf = (e: Record<string, unknown>) => {
  const { tool, tool_use_id, agentId, requestMeta, ...input } = e
  return input
}

// The id a background launch reports: a shell's `backgroundTaskId`, an async agent's `agentId`.
const backgroundId = (result: unknown) => {
  const r = result as { backgroundTaskId?: unknown; status?: unknown; agentId?: unknown } | undefined
  if (typeof r?.backgroundTaskId === 'string') return r.backgroundTaskId
  return r?.status === 'async_launched' && typeof r.agentId === 'string' ? r.agentId : undefined
}

const callItem = (call: Call, isBackground: boolean): Item => {
  const { command, description } = call.input
  const shell = call.tool === 'Bash' && typeof command === 'string' ? command : undefined
  return {
    label: `${isBackground ? '⏳ ' : ''}${call.tool}${call.isSubagent ? ' (subagent)' : ''}`,
    summary: headline(call.input),
    description: typeof description === 'string' ? description : undefined,
    body: shell ?? JSON.stringify(call.input, null, 2),
    language: shell === undefined ? 'json' : 'bash',
    startedAt: call.startedAt,
    endedAt: call.endedAt,
  }
}

// Newest first: running calls, then background work, then the last call that finished.
const active = (): Item[] => {
  const items = [
    ...[...calls.values()].reverse().map(call => callItem(call, false)),
    ...[...backgrounds.values()].reverse().map(call => callItem(call, true)),
  ]
  const isHeld = last && !isIdle && Date.now() - last.endedAt < (isTurn ? TURN_HOLD_MS : HOLD_MS)
  return items.length === 0 && last && isHeld ? [callItem(last, false)] : items
}

const statusText = (head: Item, restCount: number) =>
  `${head.endedAt === undefined ? '▶' : '✓'} ${head.label} ${clock(head)} · ${head.summary}${restCount > 0 ? ` (+${restCount})` : ''}`

const refresh = ($: EngineInterface) => {
  const [head, ...rest] = active()
  // During a turn the spinner already shows this line; the status line is for what outlives it.
  $.ui.status(head && !isTurn ? statusText(head, rest.length) : undefined)
  $.ui.invalidate('ui.render')
  if (head) {
    ticker ??= $.clock.every(TICK_MS, () => refresh($))
  } else {
    ticker?.cancel()
    ticker = undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'live',
      description: 'Toggle the pane showing the running action in full',
    })
    return next(e)
  })

  on('command.run', { command: 'live' }, async $ => {
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Live pane closed.' }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Live action' })
    isOpen = true
    return { text: isPlaced ? 'Live pane opened.' : 'Live pane opened but not drawn here.' }
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const call: Call = {
      tool: e.tool,
      input: inputOf(e),
      startedAt: Date.now(),
      isSubagent: e.agentId !== undefined,
    }
    isIdle = false
    calls.set(e.tool_use_id, call)
    refresh($)
    try {
      const ran = await next(e)
      const id = backgroundId(ran.result)
      if (id) backgrounds.set(id, call)
      // A stopped task sends no task notification.
      if (e.tool === 'TaskStop') backgrounds.delete(String(call.input.task_id))
      return ran
    } finally {
      calls.delete(e.tool_use_id)
      last = { ...call, endedAt: Date.now() }
      refresh($)
    }
  }).catch(($, e, next) => next(e))

  // A finished background task comes back as a notification prompt naming its id.
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      for (const [, id] of e.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) backgrounds.delete(id)
      refresh($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurn = true
    isIdle = false
    refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurn = false
    isIdle = true
    last = undefined
    refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A tree is drawn in a plugin card flush against the last chat row; a rewritten message keeps the engine's own row.
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    const [head, ...rest] = active()
    if (!head) return next(e)
    return next({ ...e, props: { ...e.props, message: statusText(head, rest.length), suffix: '' } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e)
    const [head, ...rest] = active()

    return (
      <Box flexDirection="column">
        {head ? (
          <Text bold size="title">
            {head.endedAt === undefined ? '▶' : '✓'} {head.label} · {clock(head)}
          </Text>
        ) : (
          <Text dimColor size="heading">Nothing running.</Text>
        )}
        {head?.description ? <Text dimColor size="heading">{head.description}</Text> : null}
        {head?.body ? (
          <Code
            source={head.body.length > BODY_LIMIT ? `${head.body.slice(0, BODY_LIMIT)}…` : head.body}
            language={head.language}
          />
        ) : null}
        {rest.map(item => (
          <Text dimColor>
            ▷ {item.label} {clock(item)} · {item.summary}
          </Text>
        ))}
      </Box>
    )
  })
}
