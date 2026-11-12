import type { EngineInterface, Register, Timer, TurnStepChunk } from 'claude-code'

const STATUS_WIDTH = 120
const SUMMARY_LIMIT = 600
// VS Code's status line: 0.9x text across the prompt box's width (the viewport the panel reports), clamped to two
// rows, with the panel's "chyron plugin " first. Characters per reported column is a fitted estimate.
const STATUS_ROWS = 2
const STATUS_CHARS_PER_COLUMN = 1.7
const STATUS_FILL = 0.95
const STATUS_PREFIX_CHARS = 15
const STATUS_FALLBACK_COLUMNS = 64
const MIN_SUMMARY_CHARS = 10
const TICK_MS = 1000
const HOLD_MS = 30_000
const TURN_HOLD_MS = 600_000
// Cells the engine draws before the message: the spinner mark and the "chyron plugin " attribution.
const SPINNER_CHROME_CELLS = 17

// A model request: the output tokens it generated, shown on every tool call it issued.
type Step = { output?: number }
// A subagent's tokens so far: its latest request's context plus everything it has generated.
type Usage = { context: number; output: number }
type Call = {
  tool: string
  input: Record<string, unknown>
  startedAt: number
  seq: number
  isSubagent: boolean
  step?: Step
  usage?: Usage
}
type Item = {
  label: string
  name: string
  isBackground: boolean
  summary: string
  tokens?: string
  startedAt: number
  seq: number
  endedAt?: number
}

let launches = 0
const calls = new Map<string, Call>()
const steps = new Map<string, Step>()
const agentUsage = new Map<string, Usage>()
const backgrounds = new Map<string, Call>()
let last: (Call & { endedAt: number }) | undefined
let isTurn = false
let isIdle = false
let compactingSince: number | undefined
let ticker: Timer | undefined
let isVscode = false
let statusColumns: number | undefined

const oneLine = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

const headline = (input: Record<string, unknown>) =>
  oneLine(
    String(
      input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ??
        input.query ?? input.skill ?? input.prompt ?? '',
    ),
    SUMMARY_LIMIT,
  )

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`

const count = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)

const usageOf = (agentId: string) => {
  const usage = agentUsage.get(agentId) ?? { context: 0, output: 0 }
  agentUsage.set(agentId, usage)
  return usage
}

// Tokens are only counted by a request's stop chunk, so each call and subagent is charged from it.
const tally = (step: Step, agentId: string | undefined, chunk: TurnStepChunk) => {
  if (chunk.kind === 'tool') {
    steps.set(chunk.id, step)
  } else if (chunk.kind === 'stop' && chunk.usage) {
    const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = chunk.usage
    step.output = output_tokens
    if (agentId !== undefined) {
      const usage = usageOf(agentId)
      usage.context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      usage.output += output_tokens
    }
  }
}

// An agent shows its own requests' total; any other call, the output of the request that issued it.
const tokenText = ({ tool, usage, step }: Call) => {
  if (usage) return usage.context + usage.output > 0 ? `${count(usage.context + usage.output)} tok` : undefined
  if (tool === 'Agent' || step?.output === undefined) return undefined
  return `${count(step.output)} out`
}

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

const callItem = (call: Call & { endedAt?: number }, isBackground: boolean): Item => {
  const name = `${call.tool}${call.isSubagent ? ' (subagent)' : ''}`
  return {
    label: `${isBackground ? '⏳ ' : ''}${name}`,
    name,
    isBackground,
    summary: headline(call.input),
    tokens: tokenText(call),
    startedAt: call.startedAt,
    seq: call.seq,
    endedAt: call.endedAt,
  }
}

// Running calls and background work, latest start first (`seq` orders calls that start in one millisecond).
const active = (): Item[] => {
  const items = [
    ...[...calls.values()].map(call => callItem(call, false)),
    ...[...backgrounds.values()].map(call => callItem(call, true)),
  ].sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq)
  const isHeld = last && !isIdle && Date.now() - last.endedAt < (isTurn ? TURN_HOLD_MS : HOLD_MS)
  return items.length === 0 && last && isHeld ? [callItem(last, false)] : items
}

const itemText = (item: Item) =>
  [
    `${item.endedAt === undefined ? '▶' : '✓'} ${item.label} ${clock(item)}`,
    item.summary && oneLine(item.summary, STATUS_WIDTH),
    item.tokens,
  ]
    .filter(Boolean)
    .join(' · ')

const compactingText = () =>
  compactingSince === undefined ? undefined : `Compacting conversation · ${seconds(Date.now() - compactingSince)}`

const statusText = (items: Item[], lead?: string) => [lead, ...items.map(itemText)].filter(Boolean).join(' │ ')

// A hook cannot measure text; estimate the wrap from the viewport width in cells.
const isWrapped = (text: string, columns?: number) => columns !== undefined && SPINNER_CHROME_CELLS + text.length > columns

// Room for each summary: an equal share of what is left, where a shorter summary hands its spare to the others.
const summaryShares = (lengths: number[], room: number) => {
  const shares = lengths.map(() => 0)
  let left = room
  const order = lengths.map((_, index) => index).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0))
  order.forEach((index, turn) => {
    const share = Math.max(MIN_SUMMARY_CHARS, Math.floor(left / (order.length - turn)))
    shares[index] = Math.min(lengths[index] ?? 0, share)
    left -= shares[index] ?? 0
  })
  return shares
}

// VS Code's status line is plain grey text: coloured emoji mark the state and tool names are upper case. The summaries
// share the room the two rows have left after the fixed parts, so the rows are filled and nothing is cut early.
const stripText = (items: Item[], lead?: string, columns = STATUS_FALLBACK_COLUMNS) => {
  const heads = items.map(item => {
    const state = item.isBackground ? '⏳' : item.endedAt === undefined ? '🟠' : '🟢'
    return `${state} ${item.name.toUpperCase()} ${clock(item)}`
  })
  const leadText = lead && `🟠 ${lead}`
  const fixedOf = (item: Item, head: string) =>
    head.length + (item.summary ? 3 : 0) + (item.tokens ? 3 + item.tokens.length : 0)
  const separators = 3 * Math.max(0, items.length - (leadText ? 0 : 1))
  const fixed = (leadText?.length ?? 0) + separators + items.reduce((sum, item, index) => sum + fixedOf(item, heads[index] ?? ''), 0)
  const capacity = Math.floor(columns * STATUS_CHARS_PER_COLUMN * STATUS_ROWS * STATUS_FILL) - STATUS_PREFIX_CHARS
  const shares = summaryShares(items.map(item => item.summary.length), capacity - fixed)
  return [
    leadText,
    ...items.map((item, index) =>
      [heads[index], item.summary && oneLine(item.summary, shares[index] ?? 0), item.tokens].filter(Boolean).join(' · '),
    ),
  ]
    .filter(Boolean)
    .join(' ┃ ')
}

const forgetTasks = (text: string) => {
  for (const [, id] of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) if (id) backgrounds.delete(id)
}

const refresh = ($: EngineInterface) => {
  const items = active()
  const isBusy = items.length > 0 || compactingSince !== undefined
  // The terminal's spinner shows this line during a turn; VS Code's is untouched, so its status line shows it.
  const text = isVscode ? stripText(items, compactingText(), statusColumns) : statusText(items, compactingText())
  $.ui.status(isBusy && (!isTurn || isVscode) ? text : undefined)
  $.ui.invalidate('ui.render')
  if (isBusy) {
    ticker ??= $.clock.every(TICK_MS, () => refresh($))
  } else {
    ticker?.cancel()
    ticker = undefined
  }
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const call: Call = {
      tool: e.tool,
      input: inputOf(e),
      startedAt: Date.now(),
      seq: launches++,
      isSubagent: e.agentId !== undefined,
      step: steps.get(e.tool_use_id),
    }
    steps.delete(e.tool_use_id)
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

  // The Agent call learns its subagent's id here; a workflow's many agents share one call, so they are skipped.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const call = calls.get(e.tool_use_id)
    if (call && spawned.agentId && !e.workflow) call.usage = usageOf(spawned.agentId)
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const step: Step = {}
    for await (const chunk of next(e)) {
      // Counting is best effort: a failure here must not cut the response short.
      try {
        tally(step, e.agentId, chunk)
      } catch {}
      yield chunk
    }
  })

  // A finished background task comes back as a notification prompt naming its id.
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      forgetTasks(e.text)
      refresh($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // An agent's notification delivered into a running turn raises no prompt.submit; its queue row does.
  on('session.append', { door: 'queue' }, ($, e, next) => {
    const text = e.message.content.map(block => (typeof block.text === 'string' ? block.text : '')).join('')
    if (text.startsWith('<task-notification>')) {
      forgetTasks(text)
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

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    compactingSince = Date.now()
    refresh($)
    try {
      return await next(e)
    } finally {
      compactingSince = undefined
      refresh($)
    }
  }).catch(($, e, next) => next(e))

  // VS Code keeps the engine's own spinner and shows the detail in the status line. Elsewhere one row rewrites the
  // engine's message, and a wrapped text goes in a card under the engine row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const items = active()
    const compacting = compactingText()
    if (e.surface === 'vscode') {
      isVscode = true
      statusColumns = e.viewport?.columns
    }
    if (e.surface === 'vscode' || (items.length === 0 && !compacting)) return next(e)
    // Keep the engine's own word (thinking, requesting, ...) first, unless a tool call is the thing running.
    const { message, word, mode } = e.props
    const lead = compacting ?? (mode === 'tool-use' ? undefined : (message ?? word))
    const text = statusText(items, lead)
    if (!isWrapped(text, e.viewport?.columns)) return next({ ...e, props: { ...e.props, message: text, suffix: '' } })
    const { Box, Text } = $.ui.resolve(e)
    const row = await next(e)
    return <Box flexDirection="column">{row}<Text>{statusText(items, compacting)}</Text></Box>
  })
}
