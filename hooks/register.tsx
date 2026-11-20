import type { EngineInterface, Register, Timer, TurnStepChunk } from 'claude-code'

const STATUS_WIDTH = 120
const SUMMARY_LIMIT = 600
// VS Code's status line: 0.9x text across the prompt box's width (the viewport the panel reports), clamped to two
// rows, with the panel's "chyron plugin " first. Characters per reported column is a fitted estimate.
const STATUS_ROWS = 2
const STATUS_CHARS_PER_COLUMN = 1.7
const STATUS_FILL = 0.95
const STATUS_PREFIX_CHARS = 15
// The owl, Chyron's logo, marks the spinner line like a channel's on-screen bug.
const OWL = '🦉'
const STATUS_FALLBACK_COLUMNS = 64
const MIN_SUMMARY_CHARS = 10
const TICK_MS = 1000
const HOLD_MS = 30_000
const TURN_HOLD_MS = 600_000
// A background task whose notification never comes (stopped from the UI, or lost) would show, and keep the ticker on, for good.
const BACKGROUND_TTL_MS = 6 * 3_600_000
const MAX_REMEMBERED = 256
// What the spinner says while a compaction runs: `Compacting conversation` on the terminal, `Compacting` in VS Code.
const COMPACTING_MESSAGE = /^compacting/i
// Cells the engine draws before the message: the spinner mark and the "chyron plugin " attribution.
const SPINNER_CHROME_CELLS = 17

// A tool call a request issues: its name and the streamed JSON of its input.
type Use = { name: string; json: string }
// A model request: the output tokens it generated, shown on every tool call it issued.
type Step = { output?: number; uses: Map<number, Use> }
// A subagent so far: its latest request's context plus everything it has generated, the tools it called and the last one.
type Progress = { context: number; output: number; tools: number; latest?: string }
type Call = {
  tool: string
  input: Record<string, unknown>
  startedAt: number
  seq: number
  isSubagent: boolean
  // The agent this call runs in, when it is a subagent's.
  agent?: Progress
  step?: Step
  progress?: Progress
}
type Item = {
  label: string
  name: string
  isBackground: boolean
  summary: string
  tokens?: string
  tools?: string
  activity?: string
  startedAt: number
  seq: number
  endedAt?: number
}
// How long each entry stood in each position of the list: per position, the entry's `seq` and its milliseconds.
export type Occupancy = Map<number, number>[]
// What is drawn: the entries and the compaction as they stood at `at`, the one time every clock in it counts to.
type Frame = { at: number; items: Item[]; compactingSince?: number }

let isOwlOn = true
let launches = 0
const calls = new Map<string, Call>()
const steps = new Map<string, Step>()
const agentProgress = new Map<string, Progress>()
const backgrounds = new Map<string, Call>()
let last: (Call & { endedAt: number }) | undefined
let isTurn = false
let isIdle = false
let compactingSince: number | undefined
// A compaction is read from the `compact` command in flight and from the spinner text the engine draws while one runs.
// `session.compact` is not hooked: Claude Code's `cc-plugin-sec-default` keeps it from mods.
let isCompactCommand = false
let isSpinnerCompacting = false
let ticker: Timer | undefined
let isVscode = false
let statusColumns: number | undefined
// Events only note who stands where; the ticker draws one frame a second from the position that held each entry longest.
let layout: Item[] = []
let sampledAt = 0
let windowMs = 0
let occupancy: Occupancy = []
let latest = new Map<number, Item>()
let shown: Frame = { at: 0, items: [] }

const oneLine = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

// The first field that says something: an empty description must not hide the command.
const headline = (input: Record<string, unknown>) => {
  const fields = [input.description, input.command, input.file_path, input.pattern, input.url, input.query, input.skill, input.prompt]
  return oneLine(String(fields.find(value => value != null && String(value).trim() !== '') ?? ''), SUMMARY_LIMIT)
}

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`

// Two digits where a unit allows (1.5k, 39k, 1.2M), rounded up so a count never reads lower than it is.
const count = (n: number) => {
  if (n < 1000) return String(n)
  if (Math.ceil(n / 100) < 100) return `${(Math.ceil(n / 100) / 10).toFixed(1)}k`
  if (Math.ceil(n / 1000) < 1000) return `${Math.ceil(n / 1000)}k`
  if (Math.ceil(n / 100_000) < 100) return `${(Math.ceil(n / 100_000) / 10).toFixed(1)}M`
  return `${Math.ceil(n / 1_000_000)}M`
}

// Keeps the newest MAX_REMEMBERED entries: a call that never ran or an agent that never finished is not pruned elsewhere.
const remember = <V,>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string)
}

const progressOf = (agentId: string) => {
  const progress = agentProgress.get(agentId) ?? { context: 0, output: 0, tools: 0 }
  remember(agentProgress, agentId, progress)
  return progress
}

const activityOf = ({ name, json }: Use) => {
  try {
    const text = headline(JSON.parse(json))
    return text ? `${name}: ${text}` : name
  } catch {
    return name
  }
}

// Tokens are only counted by a request's stop chunk, so each call and subagent is charged from it. A subagent's tools
// are read from its requests too, which reach the mod for a background agent as well.
const tally = (step: Step, agentId: string | undefined, chunk: TurnStepChunk) => {
  if (chunk.kind === 'tool') {
    remember(steps, chunk.id, step)
    if (agentId === undefined) return
    step.uses.set(chunk.index, { name: chunk.name, json: '' })
    progressOf(agentId).tools++
  } else if (chunk.kind === 'input') {
    const use = step.uses.get(chunk.index)
    if (use) use.json += chunk.json
  } else if (chunk.kind === 'stop') {
    const latest = [...step.uses.values()].pop()
    if (agentId !== undefined && latest) progressOf(agentId).latest = activityOf(latest)
    if (!chunk.usage) return
    const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = chunk.usage
    step.output = output_tokens
    if (agentId !== undefined) {
      const progress = progressOf(agentId)
      progress.context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      progress.output += output_tokens
    }
  }
}

// An agent shows its own requests' total; any other call, the output of the request that issued it.
const tokenText = ({ tool, progress, step }: Call) => {
  if (progress) return progress.context + progress.output > 0 ? `Σ${count(progress.context + progress.output)}` : undefined
  if (tool === 'Agent' || step?.output === undefined) return undefined
  return `↓${count(step.output)}`
}

const toolsText = ({ progress }: Call) =>
  progress?.tools ? `${progress.tools} ${progress.tools === 1 ? 'tool' : 'tools'}` : undefined

const clock = ({ startedAt, endedAt }: Item, at: number) =>
  endedAt === undefined ? seconds(at - startedAt) : `done ${seconds(at - endedAt)} ago`

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
    tools: toolsText(call),
    activity: call.progress?.latest,
    startedAt: call.startedAt,
    seq: call.seq,
    endedAt: call.endedAt,
  }
}

// A hook module cannot fake the clock in a test, so the expiry takes the time as an argument.
export const dropExpired = (tasks: Map<string, { startedAt: number }>, now: number) => {
  for (const [id, task] of tasks) if (now - task.startedAt > BACKGROUND_TTL_MS) tasks.delete(id)
}

// Running calls and background work, latest start first (`seq` orders calls that start in one millisecond).
// A call inside an agent that has its own entry shows there, as that entry's latest tool.
const active = (): Item[] => {
  dropExpired(backgrounds, Date.now())
  const entries = [
    ...[...calls.values()].map(call => ({ call, isBackground: false })),
    ...[...backgrounds.values()].map(call => ({ call, isBackground: true })),
  ]
  const listed = new Set(entries.map(({ call }) => call.progress))
  const items = entries
    .filter(({ call }) => !call.agent || !listed.has(call.agent))
    .map(({ call, isBackground }) => callItem(call, isBackground))
    .sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq)
  const isHeld = last && !isIdle && Date.now() - last.endedAt < (isTurn ? TURN_HOLD_MS : HOLD_MS)
  const isJustDone = last && Date.now() - last.endedAt < TICK_MS // a call that ends while idle still gets one frame
  return items.length === 0 && last && (isHeld || isJustDone) ? [callItem(last, false)] : items
}

const withTokens = (text: string, tokens?: string) => (tokens ? `${text} ${tokens}` : text)

const detail = (summary: string, activity?: string, mark = '▸') => [summary, activity].filter(Boolean).join(` ${mark} `)

// With the owl on, it stands in for the running mark of the entry right after it.
const itemText = (item: Item, at: number, isAfterOwl = false) => {
  const mark = item.endedAt !== undefined ? '✓ ' : isAfterOwl ? '' : '▶ '
  const head = `${mark}${item.label} ${clock(item, at)}`
  const text = detail(oneLine(item.summary, STATUS_WIDTH), item.activity && oneLine(item.activity, STATUS_WIDTH), isOwlOn ? OWL : undefined)
  return withTokens([head, item.tools, text].filter(Boolean).join(' · '), item.tokens)
}

const compactingText = ({ at, compactingSince: since }: Frame, dot = '·') =>
  since === undefined ? undefined : `Compacting conversation ${dot} ${seconds(at - since)}`

// On the terminal the owl stands where the dot was.
const terminalCompactingText = (frame: Frame) => compactingText(frame, isOwlOn ? OWL : undefined)

// The owl starts each entry in place of the separator and the running mark (`│ ▶`). A background entry has its own `⏳`
// there instead; the check reads the entry's kind, never the text it holds.
const statusText = ({ items, at }: Frame, lead?: string) => {
  if (!isOwlOn) return [lead, ...items.map(item => itemText(item, at))].filter(Boolean).join(' │ ')
  const entries = items.map(item => (item.isBackground ? '' : `${OWL} `) + itemText(item, at, true))
  return [lead, ...entries].filter(Boolean).join(' ')
}

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

// VS Code's status line is plain grey text: coloured emoji mark the state (so no owl leads it) and tool names are upper case. The summaries
// share the room the two rows have left after the fixed parts, so the rows are filled and nothing is cut early.
const stripText = ({ items, at }: Frame, lead?: string, columns = STATUS_FALLBACK_COLUMNS) => {
  const heads = items.map(item => {
    const state = item.isBackground ? '⏳' : item.endedAt === undefined ? '🟠' : '🟢'
    return [`${state} ${item.name.toUpperCase()} ${clock(item, at)}`, item.tools].filter(Boolean).join(' · ')
  })
  const leadText = lead && `🟠 ${lead}`
  const fixedOf = (item: Item, head: string) =>
    head.length + (item.summary || item.activity ? 3 : 0) + (item.summary && item.activity ? 3 : 0) + (item.tokens ? 1 + item.tokens.length : 0)
  const separators = 3 * Math.max(0, items.length - (leadText ? 0 : 1))
  const fixed = (leadText?.length ?? 0) + separators + items.reduce((sum, item, index) => sum + fixedOf(item, heads[index] ?? ''), 0)
  const capacity = Math.floor(columns * STATUS_CHARS_PER_COLUMN * STATUS_ROWS * STATUS_FILL) - STATUS_PREFIX_CHARS
  const shares = summaryShares(items.flatMap(item => [item.summary.length, item.activity?.length ?? 0]), capacity - fixed)
  return [
    leadText,
    ...items.map((item, index) => {
      const text = detail(oneLine(item.summary, shares[2 * index] ?? 0), item.activity && oneLine(item.activity, shares[2 * index + 1] ?? 0))
      return withTokens([heads[index], text].filter(Boolean).join(' · '), item.tokens)
    }),
  ]
    .filter(Boolean)
    .join(' ┃ ')
}

const forgetTasks = (text: string) => {
  for (const [, id] of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) if (id) backgrounds.delete(id)
}

// Credits `ms` to each entry in the position it held.
export const occupy = (occupancy: Occupancy, seqs: number[], ms: number) => {
  seqs.forEach((seq, position) => {
    const holders = (occupancy[position] ??= new Map())
    holders.set(seq, (holders.get(seq) ?? 0) + ms)
  })
}

// Per position, the entry that held it longest (the newest when tied), each entry once. A position that stood empty
// for longer than any entry held it shows nothing.
export const dominant = (occupancy: Occupancy, windowMs: number) => {
  const picked: number[] = []
  for (const holders of occupancy) {
    const empty = windowMs - [...holders.values()].reduce((sum, ms) => sum + ms, 0)
    const [best] = [...holders].filter(([seq]) => !picked.includes(seq)).sort((a, b) => b[1] - a[1] || b[0] - a[0])
    if (best && best[1] >= empty) picked.push(best[0])
  }
  return picked
}

const isBusy = () => layout.length > 0 || compactingSince !== undefined

// Credits the time since the last call to the entries as they stood, then takes them as they stand now.
const sample = (now: number) => {
  const ms = Math.max(0, now - sampledAt)
  occupy(occupancy, layout.map(item => item.seq), ms)
  windowMs += ms
  sampledAt = now
  layout = active()
  for (const item of layout) latest.set(item.seq, item)
}

const startWindow = () => {
  occupancy = []
  windowMs = 0
  latest = new Map(layout.map(item => [item.seq, item]))
}

const show = ($: EngineInterface, frame: Frame) => {
  shown = frame
  const isEmpty = frame.items.length === 0 && frame.compactingSince === undefined
  // The terminal's spinner shows this line during a turn; VS Code's is untouched, so its status line shows it.
  const text = isVscode ? stripText(frame, compactingText(frame), statusColumns) : statusText(frame, terminalCompactingText(frame))
  $.ui.status(!isEmpty && (!isTurn || isVscode) ? text : undefined)
  $.ui.invalidate('ui.render')
}

// Once the second is up every entry changes together, and an idle line clears with them.
const tick = ($: EngineInterface) => {
  const now = Date.now()
  sample(now)
  if (isBusy()) {
    show($, { at: now, items: dominant(occupancy, windowMs).flatMap(seq => latest.get(seq) ?? []), compactingSince })
  } else {
    ticker?.cancel()
    ticker = undefined
    show($, { at: now, items: [] })
  }
  startWindow()
}

// A change only draws when the line was idle: that frame starts the seconds the ticker then counts. `redraw` shows the
// frame again, for a change of what the line may show that is no new content.
const refresh = ($: EngineInterface, redraw = false) => {
  sample(Date.now())
  if (ticker) {
    if (redraw) show($, shown)
    return
  }
  if (!isBusy()) return
  startWindow()
  show($, { at: sampledAt, items: layout, compactingSince })
  ticker = $.clock.every(TICK_MS, () => tick($))
}

const syncCompacting = ($: EngineInterface) => {
  const isCompacting = isCompactCommand || isSpinnerCompacting
  if (isCompacting === (compactingSince !== undefined)) return
  compactingSince = isCompacting ? Date.now() : undefined
  refresh($)
}

export const register: Register = (on, options) => {
  isOwlOn = options.show_owl !== false

  on('tool.call', async ($, e, next) => {
    const call: Call = {
      tool: e.tool,
      input: inputOf(e),
      startedAt: Date.now(),
      seq: launches++,
      isSubagent: e.agentId !== undefined,
      agent: e.agentId === undefined ? undefined : progressOf(e.agentId),
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
    if (call && spawned.agentId && !e.workflow) call.progress = progressOf(spawned.agentId)
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const step: Step = { uses: new Map() }
    try {
      for await (const chunk of next(e)) {
        // Counting is best effort: a failure here must not cut the response short.
        try {
          tally(step, e.agentId, chunk)
        } catch {}
        yield chunk
      }
    } finally {
      // Calls outlive their request in `steps`, and the inputs they hold can be large.
      step.uses.clear()
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
    refresh($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurn = false
    isIdle = true
    last = undefined
    isSpinnerCompacting = false
    syncCompacting($)
    refresh($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'compact' }, async ($, e, next) => {
    isCompactCommand = true
    syncCompacting($)
    try {
      return await next(e)
    } finally {
      isCompactCommand = false
      // A spinner that is not drawn again when the command ends can no longer say that it ended.
      isSpinnerCompacting = false
      syncCompacting($)
    }
  }).catch(($, e, next) => next(e))

  // VS Code keeps the engine's own spinner and shows the detail in the status line. Elsewhere one row rewrites the
  // engine's message, and a wrapped text goes in a card under the engine row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    isSpinnerCompacting = COMPACTING_MESSAGE.test(e.props.message ?? '')
    syncCompacting($)
    const compacting = terminalCompactingText(shown)
    if (e.surface === 'vscode') {
      isVscode = true
      statusColumns = e.viewport?.columns
    }
    if (e.surface === 'vscode' || (shown.items.length === 0 && !compacting)) return next(e)
    // Keep the engine's own word (thinking, requesting, ...) first, unless a tool call is the thing running.
    const { message, word, mode } = e.props
    const lead = compacting ?? (mode === 'tool-use' ? undefined : (message ?? word))
    const text = statusText(shown, lead)
    if (!isWrapped(text, e.viewport?.columns)) return next({ ...e, props: { ...e.props, message: text, suffix: '' } })
    const { Box, Text } = $.ui.resolve(e)
    const row = await next(e)
    return <Box flexDirection="column">{row}<Text>{statusText(shown, compacting)}</Text></Box>
  })
}
