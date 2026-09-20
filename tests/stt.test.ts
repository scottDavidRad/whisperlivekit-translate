import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { startSttStream, type SttClient, type SttSnapshot } from '../src/asr/stt.ts'

class FakeSocket extends EventTarget {
  static OPEN = 1
  static sockets: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: unknown[] = []
  constructor(readonly url: string) { super(); FakeSocket.sockets.push(this) }
  send(data: unknown) { this.sent.push(data) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const realSocket = globalThis.WebSocket
let client: SttClient | undefined
let snapshots: SttSnapshot[]
let errors: Error[]
let statuses: string[]
function start(extra = {}) {
  client = startSttStream({ serverUrl: 'ws://localhost:8000/asr', ...extra }, s => snapshots.push(s), e => errors.push(e as Error), s => statuses.push(s))
  return FakeSocket.sockets.at(-1)!
}
function ready(socket: FakeSocket) { socket.open(); socket.message({ type: 'config', useAudioWorklet: true }) }
beforeEach(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  FakeSocket.sockets = []
  snapshots = []; errors = []; statuses = []
  mock.timers.enable({ apis: ['setTimeout'] })
})
afterEach(() => { client?.close(); client = undefined; mock.timers.reset(); globalThis.WebSocket = realSocket })

test('waits for server PCM config before sending untouched binary audio', () => {
  const socket = start()
  const chunk = new Uint8Array([1, 2, 3, 4])
  client!.sendPcm(chunk)
  chunk[0] = 9
  socket.open()
  assert.deepEqual(socket.sent, [])
  socket.message({ type: 'config', useAudioWorklet: true })
  assert.deepEqual(socket.sent, [new Uint8Array([1, 2, 3, 4])])
  assert.equal(statuses.at(-1), 'live')
})

test('replaces cumulative snapshots, preserves revisions, and separates interim text', () => {
  const socket = start(); ready(socket)
  socket.message({ lines: [{ text: 'Hello' }], buffer_transcription: 'world' })
  socket.message({ lines: [{ text: 'Hello world.' }], buffer_transcription: '' })
  socket.message({ lines: [{ text: 'Hello world.' }], buffer_transcription: '' })
  assert.deepEqual(snapshots.at(-1), { finalText: 'Hello world.', interimText: '', finished: false })
  assert.equal(snapshots[0].interimText, ' world')
})

test('does not duplicate pending diarization included in WLK 0.2.19 lines', () => {
  const socket = start(); ready(socket)
  socket.message({ lines: [{ text: 'Hello.' }, { text: ' New words.' }], buffer_diarization: ' New words.', buffer_transcription: 'Next' })
  assert.equal(snapshots.at(-1)!.finalText + snapshots.at(-1)!.interimText, 'Hello. New words. Next')
})

test('renders silence and speaker IDs without control text', () => {
  const socket = start({ speakerLabels: true, splitSentences: true }); ready(socket)
  socket.message({ lines: [{ text: 'One', speaker: 1 }, { text: '', speaker: -2 }, { text: 'Two', speaker: 2 }] })
  assert.equal(snapshots.at(-1)!.finalText, 'Speaker 1: One\nSpeaker 2: Two')
})

test('speaker changes get readable turns even with sentence splitting disabled', () => {
  const socket = start({ speakerLabels: true, splitSentences: false }); ready(socket)
  socket.message({ lines: [
    { text: 'First.', speaker: 3 },
    { text: 'Still first.', speaker: 3 },
    { text: 'Second.', speaker: 1 },
    { text: 'First again.', speaker: 3 },
  ] })
  assert.equal(snapshots.at(-1)!.finalText,
    'Speaker 1: First. Still first.\nSpeaker 2: Second.\nSpeaker 1: First again.')
})

test('holds delayed diarization text unassigned and replaces it when attribution arrives', () => {
  const socket = start({ speakerLabels: true }); ready(socket)
  socket.message({
    lines: [{ text: 'Hello.', speaker: 1 }, { text: ' New words.', speaker: 1 }],
    buffer_diarization: ' New words.',
    buffer_transcription: 'More',
  })
  assert.deepEqual(snapshots.at(-1), {
    finalText: 'Speaker 1: Hello.',
    interimText: '\nSpeaker pending: New words. More',
    finished: false,
  })
  socket.message({ lines: [{ text: 'Hello.', speaker: 1 }, { text: ' New words. More.', speaker: 2 }] })
  assert.deepEqual(snapshots.at(-1), {
    finalText: 'Speaker 1: Hello.\nSpeaker 2: New words. More.', interimText: '', finished: false,
  })
})

test('pending diarization can span multiple lines or part of a line', () => {
  const socket = start({ speakerLabels: true }); ready(socket)
  socket.message({
    lines: [{ text: 'Known. Pending one.', speaker: 2 }, { text: 'Pending two.', speaker: 1 }],
    buffer_diarization: 'Pending one.  Pending two.',
  })
  assert.equal(snapshots.at(-1)!.finalText, 'Speaker 1: Known.')
  assert.equal(snapshots.at(-1)!.interimText, '\nSpeaker pending: Pending one.  Pending two.')
})

test('speaker revisions replace earlier attribution without duplicating words', () => {
  const socket = start({ speakerLabels: true }); ready(socket)
  socket.message({ lines: [{ text: 'One.', speaker: 1 }, { text: 'Two.', speaker: 2 }] })
  socket.message({ lines: [{ text: 'One. Two.', speaker: 1 }] })
  assert.equal(snapshots.at(-1)!.finalText, 'Speaker 1: One. Two.')
})

test('unassigned speaker values are never represented as identified voices', () => {
  const socket = start({ speakerLabels: true }); ready(socket)
  socket.message({ lines: [null, { text: 'Unassigned.', speaker: -1 }, { text: 'Still unknown.', speaker: 0 }, { text: 'Known.', speaker: 2 }] })
  assert.equal(snapshots.at(-1)!.finalText, 'Speaker pending: Unassigned. Still unknown.\nSpeaker 1: Known.')
})

test('reconnect does not reuse old speaker identities for a fresh backend session', () => {
  const socket = start({ speakerLabels: true }); ready(socket)
  socket.message({ lines: [{ text: 'Before.', speaker: 1 }] })
  socket.close(); mock.timers.tick(500)
  const next = FakeSocket.sockets.at(-1)!; ready(next)
  next.message({ lines: [{ text: 'After.', speaker: 1 }] })
  assert.equal(snapshots.at(-1)!.finalText, 'Speaker 1: Before.\nSpeaker 2: After.')
})

test('rejects non-PCM server before audio leaves and never retries fatal errors', () => {
  const socket = start(); client!.sendPcm(new Uint8Array([1, 2])); socket.open()
  socket.message({ type: 'config', useAudioWorklet: false })
  assert.match(errors[0].message, /--pcm-input/)
  assert.deepEqual(socket.sent, [])
  mock.timers.tick(30_000)
  assert.equal(FakeSocket.sockets.length, 1)
})

test('reconnect preserves committed history and spacing without replaying old snapshots', () => {
  const socket = start(); ready(socket)
  socket.message({ lines: [{ text: 'Hello' }], buffer_transcription: 'discard' })
  socket.close()
  mock.timers.tick(500)
  const next = FakeSocket.sockets.at(-1)!; ready(next)
  socket.message({ lines: [{ text: 'stale' }] })
  next.message({ lines: [], buffer_transcription: 'there' })
  assert.equal(snapshots.at(-1)!.finalText + snapshots.at(-1)!.interimText, 'Hello there')
  next.message({ lines: [{ text: 'There.' }], buffer_transcription: '' })
  assert.equal(snapshots.at(-1)!.finalText, 'Hello\nThere.')
})

test('bounds preconnect audio and applies websocket backpressure', () => {
  const socket = start()
  for (let i = 0; i < 10; i++) client!.sendPcm(new Uint8Array(32_000))
  ready(socket)
  assert.equal(socket.sent.length, 5)
  socket.bufferedAmount = 256_001
  client!.sendPcm(new Uint8Array([1, 2]))
  assert.equal(socket.sent.length, 5)
})

test('finish sends empty binary then waits for final result and ready_to_stop', () => {
  const socket = start(); ready(socket)
  client!.finish()
  assert.ok(socket.sent[0] instanceof Uint8Array)
  assert.equal((socket.sent[0] as Uint8Array).byteLength, 0)
  assert.equal(socket.readyState, 1)
  socket.message({ lines: [{ text: 'Final words.' }] })
  socket.message({ type: 'ready_to_stop' })
  assert.equal(snapshots.at(-1)!.finished, true)
  assert.equal(snapshots.at(-1)!.finalText, 'Final words.')
  assert.equal(socket.readyState, 3)
})

test('finish during handshake flushes buffered audio before binary stop', () => {
  const socket = start(); client!.sendPcm(new Uint8Array([1, 2])); client!.finish(); ready(socket)
  assert.deepEqual(socket.sent, [new Uint8Array([1, 2]), new Uint8Array(0)])
})

test('unexpected close while finishing is an error, not success', () => {
  const socket = start(); ready(socket); client!.finish(); socket.close()
  assert.match(errors[0].message, /before confirming/)
  assert.equal(snapshots.some(s => s.finished), false)
})

test('aborting suppresses queued callbacks and reconnect', () => {
  const socket = start(); ready(socket); client!.close()
  socket.message({ lines: [{ text: 'too late' }] })
  mock.timers.tick(100_000)
  assert.equal(snapshots.length, 0)
  assert.equal(FakeSocket.sockets.length, 1)
})

test('reports server errors and silent handshake timeouts', () => {
  let socket = start(); ready(socket); socket.message({ status: 'error', error: 'inference failed' })
  assert.match(errors[0].message, /inference failed/)
  socket = start(); socket.open(); mock.timers.tick(15_000)
  assert.match(errors[1].message, /PCM configuration/)
})

test('requests manual input and task and requires the backend to acknowledge both', () => {
  const socket = start({ sourceLanguage: 'ru', task: 'translate' })
  assert.equal(new URL(socket.url).searchParams.get('language'), 'ru')
  assert.equal(new URL(socket.url).searchParams.get('task'), 'translate')
  socket.open()
  socket.message({ type: 'config', useAudioWorklet: true, source_language: 'ru', translation_mode: 'english' })
  assert.equal(statuses.at(-1), 'live')
  assert.deepEqual(errors, [])
})

test('rejects an ignored manual language before sending queued speech', () => {
  const socket = start({ sourceLanguage: 'ru' })
  client!.sendPcm(new Uint8Array([1, 2]))
  socket.open()
  socket.message({ type: 'config', useAudioWorklet: true, source_language: 'auto' })
  assert.equal(errors.length, 1)
  assert.deepEqual(socket.sent, [])
})

test('Conversate requires source transcription rather than an English-only stream', () => {
  const socket = start({ sourceLanguage: 'auto', task: 'transcribe' })
  socket.open()
  socket.message({ type: 'config', useAudioWorklet: true, source_language: 'auto', translation_mode: 'english' })
  assert.match(errors[0].message, /speech task/)
  assert.equal(statuses.includes('live'), false)
})

test('unsupported manual language is rejected before opening any socket', () => {
  assert.throws(() => start({ sourceLanguage: 'made-up' }), /Unsupported input/)
  assert.equal(FakeSocket.sockets.length, 0)
})
