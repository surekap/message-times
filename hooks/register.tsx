import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MessageTimes } from '../types'

// Stamps live in session state, so a reload of the mod keeps them and a new
// stamp redraws only the rows that read it.
const byId = atom({ plugin: 'message-times', key: 'byId' } as const, {} as MessageTimes)
const byText = atom({ plugin: 'message-times', key: 'byText' } as const, {} as MessageTimes)

// Prompt origins that are the person's own words (typed, sent from the desktop
// or phone, or through a channel). Notifications, peers and plugins are not.
const MINE = new Set(['composer', 'bridge', 'sdk', 'channel', 'unclassified', 'slack-ping'])

// Rows of the user role that hold engine text, not a prompt.
const NOT_PROMPT = /^\s*<(command-|local-command|task-notification|bash-|user-prompt-submit-hook|system-reminder)/

// fs.read refuses a file over 4 MiB; a larger transcript is streamed instead.
const READ_LIMIT = 4 * 1024 * 1024

type Stamp = { id?: string; text?: string; t: number }

function textKey(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat ? `${flat.length}:${flat.slice(0, 300)}` : ''
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(b => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some(b => b && typeof b === 'object' && b.type === 'tool_result')
}

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const withDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const withYear = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

// The time alone while the whole session sits in today; once it runs over more
// than one day, every stamp carries its date too (and its year, if not this one).
export function label(t: number, now: number, showDate: boolean): string {
  const a = new Date(t)
  const b = new Date(now)

  if (!showDate && a.toDateString() === b.toDateString()) {
    return timeOnly.format(a)
  }

  return a.getFullYear() === b.getFullYear() ? withDay.format(a) : withYear.format(a)
}

function spansDays(stamps: MessageTimes, now: number): boolean {
  const today = new Date(now).toDateString()

  return Object.values(stamps).some(t => new Date(t).toDateString() !== today)
}

async function stamp($: EngineInterface, entries: Stamp[], keep: 'new' | 'old'): Promise<void> {
  const ids: MessageTimes = {}
  const texts: MessageTimes = {}

  for (const x of entries) {
    if (x.id) {
      ids[x.id] = x.t
    }

    const k = x.text ? textKey(x.text) : ''

    if (k) {
      texts[k] = x.t
    }
  }

  const merge = (cur: MessageTimes | undefined, add: MessageTimes) =>
    keep === 'new' ? { ...(cur ?? {}), ...add } : { ...add, ...(cur ?? {}) }

  if (Object.keys(ids).length > 0) {
    await update($, byId, cur => merge(cur, ids))
  }

  if (Object.keys(texts).length > 0) {
    await update($, byText, cur => merge(cur, texts))
  }
}

// The row's stamp drawn as text, or undefined when it has none. Reads both
// tables, so every stamped row redraws when a new stamp lands (a new day too).
async function stampLabel($: EngineInterface, id: string, text: string): Promise<string | undefined> {
  const ids = (await read($, byId)) ?? {}
  const texts = (await read($, byText)) ?? {}
  const t = ids[id] ?? texts[textKey(text)]

  if (t === undefined) {
    return undefined
  }

  const now = await $.clock.now()

  return label(t, now, spansDays(ids, now))
}

// Reads the transcript rows in order and stamps every prompt of the person's
// and the last reply with text before the next prompt (the turn's final reply).
function transcriptReader() {
  const out: Stamp[] = []
  let last: Stamp | null = null

  const line = (raw: string) => {
    if (!raw.includes('"timestamp"')) {
      return
    }

    let r: any

    try {
      r = JSON.parse(raw)
    } catch {
      return
    }

    if (r.isSidechain || (r.type !== 'user' && r.type !== 'assistant')) {
      return
    }

    const t = Date.parse(r.timestamp)
    const content = r.message?.content

    if (!Number.isFinite(t) || typeof r.uuid !== 'string') {
      return
    }

    if (r.type === 'assistant') {
      const text = blocksText(content)

      if (text.trim()) {
        last = { id: r.uuid, text, t }
      }

      return
    }

    if (r.isMeta || hasToolResult(content)) {
      return
    }

    const text = blocksText(content)

    if (!text.trim()) {
      return
    }

    // Any prompt row closes the turn before it, a notification's too.
    if (last) {
      out.push(last)
      last = null
    }

    const kind = r.origin?.kind ?? r.turnOrigin

    if ((kind === undefined || kind === 'human') && !NOT_PROMPT.test(text)) {
      out.push({ id: r.uuid, text, t })
    }
  }

  const finish = () => {
    if (last) {
      out.push(last)
      last = null
    }

    return out
  }

  return { line, finish }
}

async function transcriptPath($: EngineInterface, cwd: string): Promise<string | null> {
  const id = await $.session.id()
  const home = await $.env.get('HOME')
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const root = configured ?? (home ? `${home}/.claude` : null)

  if (!root) {
    return null
  }

  const projects = `${root}/projects`
  const guess = `${projects}/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`

  if (await $.fs.exists(guess)) {
    return guess
  }

  // The session may have started in another folder: look in each project.
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') {
      continue
    }

    const path = `${projects}/${dir.name}/${id}.jsonl`

    if (await $.fs.exists(path)) {
      return path
    }
  }

  return null
}

async function backfill($: EngineInterface, cwd: string): Promise<void> {
  const path = await transcriptPath($, cwd)

  if (!path) {
    return
  }

  const reader = transcriptReader()
  const { size } = await $.fs.stat(path)

  if (size <= READ_LIMIT) {
    const text = await $.fs.read(path)

    for (const raw of text.split('\n')) {
      reader.line(raw)
    }
  } else {
    let carry = ''

    for await (const piece of $.process.spawn({ argv: ['cat', path] })) {
      if (!('stream' in piece) || piece.stream !== 'stdout') {
        continue
      }

      const parts = (carry + piece.text).split('\n')
      carry = parts.pop() ?? ''

      for (const raw of parts) {
        reader.line(raw)
      }
    }

    reader.line(carry)
  }

  await stamp($, reader.finish(), 'old')
}

export const register: Register = on => {
  // The newest reply with text on the main loop, waiting for its turn to end.
  let pending: Stamp | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Outside the hook's budget: the transcript can be large.
    $.clock.after(0, () => {
      void backfill($, e.cwd).catch(err => $.ui.log(`message-times: backfill failed: ${String(err)}`, { to: 'debug' }))
    })

    return started
  })

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const kept = await next(e)

    if (e.agentId || kept.deny !== undefined || !kept.uuid) {
      return kept
    }

    pending = null

    const origin = e.origin as { kind: string }
    const text = blocksText(e.message.content)

    if (e.message.isMeta || !MINE.has(origin.kind) || !text.trim() || NOT_PROMPT.test(text)) {
      return kept
    }

    await stamp($, [{ id: kept.uuid, text, t: await $.clock.now() }], 'new')

    return kept
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const kept = await next(e)

    if (e.agentId || kept.deny !== undefined || !kept.uuid || e.message.type !== 'assistant') {
      return kept
    }

    const text = blocksText(e.message.content)

    if (text.trim()) {
      pending = { id: kept.uuid, text, t: await $.clock.now() }
    }

    return kept
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId || !pending) {
      return result
    }

    const final = pending
    pending = null
    await stamp($, [final, { text: e.answer, t: final.t }], 'new')

    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!MINE.has(e.props.origin.kind)) {
      return next(e)
    }

    const stamp = await stampLabel($, e.requestId, e.props.text)

    if (stamp === undefined) {
      return next(e)
    }

    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1}>
          {row}
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{stamp}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // On the desktop a reply's id is the API message's (`msg_...-t0`), not the
    // stored row's, so a reply is usually found by its text.
    const stamp = await stampLabel($, e.requestId, e.props.text)

    if (stamp === undefined) {
      return next(e)
    }

    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1}>
          {row}
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{stamp}</Text>
        </Box>
      </Box>
    )
  })
}
