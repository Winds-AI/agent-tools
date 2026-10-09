import { test, expect, mock } from 'claude-code/testing'

test('native turn stream preserves chunks and the downstream return value', async ($, on) => {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'Visible progress.' }
    yield { kind: 'thinking', index: 1, text: 'A private block.' }
    yield { kind: 'tool', index: 2, id: 'tool-1', name: 'Read' }
    return { turnId: e.turnId, index: e.index, answer: 'Finished.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const stream = $.turn.step({ turnId: 'native-test', index: 0, model: 'test', messageCount: 1 })
  expect((await stream.next()).value.text).toBe('Visible progress.')
  expect((await stream.next()).value.kind).toBe('thinking')
  expect((await stream.next()).value.name).toBe('Read')
  const end = await stream.next()
  expect(end.done).toBe(true)
  expect(end.value.answer).toBe('Finished.')
})

test('live captions draw using the native terminal element table', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { UVOICE_BRIDGE_TOKEN: 'native-test-bridge-token-0123456789abcdef' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => { throw new Error('Voice captions must not create permanent UI logs') })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('session.messages', () => ({ value: [] }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, text: '{}', headers: {} } }))
  on('process.spawn', async function* () {
    for (const event of [
      { type: 'ready', port: 4567 },
      { type: 'status', phase: 'listening' },
      { type: 'transcript', role: 'U', utteranceId: 'native-u', text: 'Keep the API', delta: 'Keep the API', sequence: 1 },
      { type: 'transcript', role: 'U', utteranceId: 'native-u', text: 'Keep the API', final: true },
    ]) yield { stream: 'stdout', text: JSON.stringify(event) + '\n' }
    await clock.sleep(500)
    return { code: 0, signal: null }
  })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  const starting = $.command.run({ command: 'v', args: '' })
  await clock.settle()
  await starting
  const ui = await $.ui.mount({ plugin: 'uvoice', surface: 'terminal', component: 'AbovePrompt', props: {
    hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 75,
    scroll: { offset: 0, bodyRows: 4 }, view: {},
  } })
  expect((await ui.find({ type: 'Text', text: /You: Keep the API/ }))?.text).toBe('You: Keep the API')
  await ui.unmount()
  const stopping = $.command.run({ command: 'v', args: '' })
  await clock.advance(1000)
  await stopping
})

test('native captions disappear on acceptance and late finals do not bring them back', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { UVOICE_BRIDGE_TOKEN: 'native-test-bridge-token-0123456789abcdef' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => { throw new Error('Voice captions must not create permanent UI logs') })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('session.messages', () => ({ value: [] }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, text: '{}', headers: {} } }))
  // Swallow the actual host submission: this test must never call a model.
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('process.spawn', async function* () {
    for (const event of [
      { type: 'ready', port: 4567 },
      { type: 'status', phase: 'listening' },
      { type: 'transcript', role: 'U', utteranceId: 'native-u', text: 'Fix parser', delta: 'Fix parser', sequence: 1 },
      { type: 'transcript', role: 'U', utteranceId: 'native-u', text: 'Fix parser', final: true },
    ]) yield { stream: 'stdout', text: JSON.stringify(event) + '\n' }
    await clock.sleep(500)
    yield { stream: 'stdout', text: JSON.stringify({ type: 'delegate', id: 'native-request', text: 'Fix parser', watermark: 1 }) + '\n' }
    await clock.sleep(500)
    yield { stream: 'stdout', text: JSON.stringify({ type: 'transcript', role: 'U', utteranceId: 'native-u', text: 'Fix parser', final: true }) + '\n' }
    await clock.sleep(500)
    return { code: 0, signal: null }
  })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  const starting = $.command.run({ command: 'v', args: '' })
  await clock.settle()
  await starting
  const ui = await $.ui.mount({ plugin: 'uvoice', surface: 'terminal', component: 'AbovePrompt', props: {
    hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 75,
    scroll: { offset: 0, bodyRows: 4 }, view: {},
  } })
  expect((await ui.find({ type: 'Text', text: /You: Fix parser/ }))?.text).toBe('You: Fix parser')
  await clock.advance(500)
  await clock.settle()
  expect(Boolean(await ui.find({ type: 'Text', text: /You: Fix parser/ }))).toBe(false)
  await clock.advance(500)
  await clock.settle()
  expect(Boolean(await ui.find({ type: 'Text', text: /You: Fix parser/ }))).toBe(false)
  await ui.unmount()
  const stopping = $.command.run({ command: 'v', args: '' })
  await clock.advance(1000)
  await stopping
})
