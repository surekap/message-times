import type { PromptOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 08:02:45 UTC on 12 Nov 2026.
const NOW = Date.UTC(2026, 10, 12, 8, 2, 45)
const hhmm = (t: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(t)
const TIME = /\d:\d\d/

const prompt = (requestId: string, text: string, kind: 'composer' | 'sdk' | 'task-notification' = 'composer') =>
  ({
    plugin: 'message-times',
    component: 'UserMessage',
    requestId,
    props: { text, origin: { kind } as PromptOrigin, isExpanded: true },
  }) as const

const reply = (requestId: string, text: string) =>
  ({
    plugin: 'message-times',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
  }) as const

const text = (s: string) => [{ type: 'text', text: s }]

test('a prompt and the final reply show the local time; a middle reply does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.session(on)
  mock.env(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.append({
    message: { type: 'user', role: 'user', content: text('hello') },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'p1',
  } as any)
  await clock.advance(60_000)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: text('working on it') },
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid: 'a1',
  } as any)
  await clock.advance(60_000)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: text('done') },
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid: 'a2',
  } as any)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const user = await $.ui.mount({ ...prompt('p1', 'hello'), surface })
    expect((await user.find({ type: 'Text', text: TIME }))?.text).toBe(hhmm(NOW))
    expect((await user.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await user.unmount()

    const middle = await $.ui.mount({ ...reply('a1', 'working on it'), surface })
    expect(await middle.find({ type: 'Text', text: TIME })).toBeUndefined()
    await middle.unmount()

    const final = await $.ui.mount({ ...reply('a2', 'done'), surface })
    expect((await final.find({ type: 'Text', text: TIME }))?.text).toBe(hhmm(NOW + 120_000))
    await final.unmount()
  }
})

test('once a session runs over two days, every stamp shows its date', async ($, on) => {
  const dated = (t: number) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t)
  const late = NOW - 14 * 60 * 60_000 // the evening before NOW, in local time
  const clock = mock.clock(on, { now: late })
  mock.session(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.append({
    message: { type: 'user', role: 'user', content: text('evening ask') },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'p1',
  } as any)

  // Still the same day: the time alone.
  const before = await $.ui.mount({ ...prompt('p1', 'evening ask'), surface: 'desktop' })
  expect((await before.find({ type: 'Text', text: TIME }))?.text).toBe(hhmm(late))
  await before.unmount()

  await clock.set(NOW)
  await $.session.append({
    message: { type: 'user', role: 'user', content: text('morning ask') },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'p2',
  } as any)

  for (const [id, words, t] of [
    ['p1', 'evening ask', late],
    ['p2', 'morning ask', NOW],
  ] as const) {
    const ui = await $.ui.mount({ ...prompt(id, words), surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: TIME }))?.text).toBe(dated(t))
    await ui.unmount()
  }
})

test('a row whose id differs is matched by its text', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.session(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.append({
    message: { type: 'user', role: 'user', content: text('look  at\nthis') },
    door: 'prompt',
    origin: { kind: 'sdk' },
    uuid: 'stored-id',
  } as any)

  const ui = await $.ui.mount({ ...prompt('drawn-id', 'look at this', 'sdk'), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: TIME }))?.text).toBe(hhmm(NOW))
  await ui.unmount()
})

test('a task notification gets no stamp', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.session(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.append({
    message: { type: 'user', role: 'user', content: text('<task-notification>done</task-notification>') },
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: 'n1',
  } as any)

  const ui = await $.ui.mount({ ...prompt('n1', 'done', 'task-notification'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: TIME })).toBeUndefined()
  await ui.unmount()
})

test('earlier messages are stamped from the transcript file', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString()
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: at(30), origin: { kind: 'human' }, message: { role: 'user', content: 'first ask' } },
    { type: 'assistant', uuid: 'r1', timestamp: at(29), message: { role: 'assistant', content: text('looking') } },
    { type: 'user', uuid: 'tr', timestamp: at(28), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'user', uuid: 'meta', timestamp: at(28), isMeta: true, message: { role: 'user', content: text('reminder') } },
    { type: 'assistant', uuid: 'r2', timestamp: at(27), message: { role: 'assistant', content: text('first answer') } },
    {
      type: 'user',
      uuid: 'n1',
      timestamp: at(20),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>job done</task-notification>' },
    },
    { type: 'assistant', uuid: 'r2b', timestamp: at(19), message: { role: 'assistant', content: text('noted the job') } },
    { type: 'user', uuid: 'u2', timestamp: at(10), origin: { kind: 'human' }, message: { role: 'user', content: 'second ask' } },
    { type: 'assistant', uuid: 'r3', timestamp: at(9), message: { role: 'assistant', content: text('second answer') } },
  ]
  const jsonl = rows.map(r => JSON.stringify(r)).join('\n') + '\n'

  on('session.id', () => ({ value: 'sid' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/me/.claude/projects/-work-app/sid.jsonl' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: jsonl.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: jsonl }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const expectTime = async (row: ReturnType<typeof prompt> | ReturnType<typeof reply>, t: number | null) => {
    const ui = await $.ui.mount({ ...row, surface: 'desktop' })
    const found = await ui.find({ type: 'Text', text: TIME })
    expect(found?.text).toBe(t === null ? undefined : hhmm(t))
    await ui.unmount()
  }

  await expectTime(prompt('u1', 'first ask'), NOW - 30 * 60_000)
  await expectTime(reply('r1', 'looking'), null)
  await expectTime(reply('r2', 'first answer'), NOW - 27 * 60_000)
  // The desktop draws a reply under the API message's id: found by its text.
  await expectTime(reply('msg_abc-t0', 'first answer'), NOW - 27 * 60_000)
  await expectTime(prompt('n1', 'job done', 'task-notification'), null)
  await expectTime(reply('r2b', 'noted the job'), NOW - 19 * 60_000)
  await expectTime(prompt('u2', 'second ask'), NOW - 10 * 60_000)
  await expectTime(reply('r3', 'second answer'), NOW - 9 * 60_000)
})
