import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationSession, conversationRequest, conversationUrl } from '../src/conversation.ts'

const originalFetch = globalThis.fetch
let session: ConversationSession | undefined
afterEach(() => { session?.dispose(); session = undefined; globalThis.fetch = originalFetch; mock.timers.reset() })

test('AI endpoint follows private TLS and reverse-proxy prefix without speech query options', () => {
  assert.equal(conversationUrl('wss://mini.example/private/asr?language=ru&task=translate', 'cue'), 'https://mini.example/private/conversation/cue')
})

test('AI failure is explicit and does not turn provider errors into a cue', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'Configure Grok on the backend.' }), { status: 503 })
  await assert.rejects(conversationRequest('ws://localhost/asr', 'cue', { transcript: 'hello' }), /Configure Grok/)
})

test('committed speech triggers one request, no duplicate work on cumulative snapshots', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const requests: unknown[] = []
  const cues: unknown[] = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options?.body as string))
    return new Response(JSON.stringify({ kind: 'suggestion', text: 'Confirm the Friday deadline.' }))
  }
  session = new ConversationSession({ serverUrl: 'ws://localhost/asr', prepNotes: '', provider: 'codex', onCue: cue => cues.push(cue), onStatus() {} })
  session.update('We agreed to send the proposal by Friday.')
  await session.request()
  session.update('We agreed to send the proposal by Friday.')
  mock.timers.tick(20_000)
  assert.equal(requests.length, 1)
  assert.equal(cues.length, 1)
  assert.equal((requests[0] as { provider: string }).provider, 'codex')
})

test('pause aborts the provider and suppresses a late response', async () => {
  let complete!: (response: Response) => void
  let signal: AbortSignal | undefined
  globalThis.fetch = (_url, options) => {
    signal = options?.signal as AbortSignal
    return new Promise(resolve => { complete = resolve })
  }
  const cues: unknown[] = []
  session = new ConversationSession({ serverUrl: 'ws://localhost/asr', prepNotes: '', provider: 'codex', onCue: cue => cues.push(cue), onStatus() {} })
  session.update('Can you clarify the project deadline for us?')
  const pending = session.request()
  session.pause()
  assert.equal(signal?.aborted, true)
  complete(new Response(JSON.stringify({ kind: 'answer', text: 'A stale cue' })))
  await pending
  assert.deepEqual(cues, [])
})

test('an unhelpful response stays quiet instead of displaying filler', async () => {
  const cues: unknown[] = []
  globalThis.fetch = async () => new Response(JSON.stringify({ kind: 'none', text: '' }))
  session = new ConversationSession({ serverUrl: 'ws://localhost/asr', prepNotes: '', provider: 'qwen', onCue: cue => cues.push(cue), onStatus() {} })
  session.update('Hello, it is nice to see you again today.')
  await session.request()
  assert.deepEqual(cues, [])
})

test('an aborted cue automatically retries the same speech after Resume', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let complete!: (response: Response) => void
  const requests: string[] = []
  const cues: unknown[] = []
  globalThis.fetch = (_url, options) => {
    requests.push(JSON.parse(options?.body as string).transcript)
    return new Promise(resolve => { complete = resolve })
  }
  session = new ConversationSession({ serverUrl: 'ws://localhost/asr', prepNotes: '', provider: 'codex', onCue: cue => cues.push(cue), onStatus() {} })
  session.update('Please confirm whether the deadline is next Friday.')
  const firstRequest = session.request()
  session.pause()
  complete(new Response(JSON.stringify({ kind: 'answer', text: 'Discard this interrupted cue.' })))
  await firstRequest
  assert.deepEqual(cues, [])
  session.resume()
  mock.timers.tick(12_000)
  assert.equal(requests.length, 2, 'Resume schedules another request without new speech')
  assert.equal(requests[1], requests[0])
  complete(new Response(JSON.stringify({ kind: 'suggestion', text: 'Confirm the Friday deadline.' })))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(cues, [{ kind: 'suggestion', text: 'Confirm the Friday deadline.' }])
})
