#!/usr/bin/env node
// Full app integration in a headless DOM: actual main.ts, SDK event parser,
// speech socket, phone UI, and glasses layout. Native hardware calls are stubbed.
// Run: WHISPERLIVEKIT_URL=ws://127.0.0.1:8000/asr EXPECT_TEXT='quick brown fox' \
//   node --import tsx scripts/browser-smoke.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
// Import before installing window: prevent the SDK from auto-initializing its
// native host transport. All SDK containers and event decoding remain real.
import { evenHubEventFromJson, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

const url = process.env.WHISPERLIVEKIT_URL || 'ws://127.0.0.1:8000/asr'
const speech = process.argv[2] || 'The quick brown fox jumps over the lazy dog.'
const expected = process.env.EXPECT_TEXT ? new RegExp(process.env.EXPECT_TEXT, 'is') : /\S/
const outputMode = process.env.OUTPUT_MODE === 'translation' ? 'translation' : 'transcript'
const temp = mkdtempSync(join(tmpdir(), 'whisperlivekit-app-smoke-'))
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://localhost:5173',
})
const calls = []
const upgrades = []
const callbacks = new Set()
const sockets = new Set()
let microphone = false
let audioEvents = 0
let pcmBytes = 0
let finishFrames = 0
let finishAcknowledgments = 0
let savedSettings = JSON.stringify({ ...DEFAULT_SETTINGS, serverUrl: url, outputMode })
const globals = new Map()

function installGlobal(name, value) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

const NativeWebSocket = globalThis.WebSocket
assert.ok(NativeWebSocket, 'Node 22 or newer is required for built-in WebSocket support.')
class ObservedWebSocket extends NativeWebSocket {
  constructor(...args) {
    super(...args)
    sockets.add(this)
    this.addEventListener('message', event => {
      if (typeof event.data !== 'string') return
      try {
        if (JSON.parse(event.data).type === 'ready_to_stop') finishAcknowledgments++
      } catch { /* The application handles response validation. */ }
    })
  }
  send(data) {
    if (typeof data !== 'string' && data.byteLength === 0) finishFrames++
    else if (typeof data !== 'string') pcmBytes += data.byteLength
    super.send(data)
  }
}

function emit(type, jsonData) {
  const event = evenHubEventFromJson({ type, jsonData })
  assert.ok(event, `The SDK must parse ${type}.`)
  for (const callback of callbacks) callback(event)
}

function phoneText() {
  return (dom.window.document.querySelector('#tl-final')?.textContent || '') +
    (dom.window.document.querySelector('#tl-interim')?.textContent || '')
}

async function until(predicate, description, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    const status = dom.window.document.querySelector('#status')
    if (status?.classList.contains('status-error')) {
      throw new Error(dom.window.document.querySelector('#status-message')?.textContent || 'Application error')
    }
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}. Phone text: ${phoneText()}`)
    await sleep(50)
  }
}

try {
  let input = process.env.AUDIO_FILE
  if (!input) {
    if (process.platform !== 'darwin') throw new Error('Set AUDIO_FILE to a speech recording on systems without macOS say.')
    input = join(temp, 'speech.aiff')
    execFileSync('say', [...(process.env.SAY_VOICE ? ['-v', process.env.SAY_VOICE] : []), '-o', input, '--', speech])
  }
  const pcmPath = join(temp, 'speech.pcm')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-f', 's16le', pcmPath])
  const pcm = Buffer.concat([readFileSync(pcmPath), Buffer.alloc(32_000)])

  installGlobal('window', dom.window)
  installGlobal('document', dom.window.document)
  installGlobal('location', dom.window.location)
  installGlobal('WebSocket', ObservedWebSocket)
  dom.window.EvenAppBridge = {
    _ready: true,
    async getLocalStorage() { return savedSettings },
    async setLocalStorage(key, value) { savedSettings = value; calls.push({ method: 'setLocalStorage', key }); return true },
    async createStartUpPageContainer(page) { calls.push({ method: 'createStartUpPageContainer', page }); return 0 },
    async rebuildPageContainer(page) { calls.push({ method: 'rebuildPageContainer', page }); return true },
    async textContainerUpgrade(update) { upgrades.push(update); return true },
    async audioControl(enabled) { microphone = enabled; calls.push({ method: 'audioControl', enabled }); return true },
    async shutDownPageContainer() { calls.push({ method: 'shutDownPageContainer' }); return true },
    onEvenHubEvent(callback) { callbacks.add(callback); return () => callbacks.delete(callback) },
  }

  await import('../src/main.ts')
  await until(() => microphone && dom.window.document.querySelector('#status')?.textContent === 'Live', 'app connected and microphone enabled')
  const startup = calls.find(call => call.method === 'createStartUpPageContainer')
  assert.equal(startup?.page.containerTotalNum, 1, 'App creates one glasses pane.')
  assert.equal(dom.window.document.querySelectorAll('section.pane').length, 1, 'Phone displays one output pane.')
  assert.equal(dom.window.document.querySelector('#serverUrl').value, url)
  assert.equal(dom.window.document.querySelector('#tl-label').textContent, outputMode === 'translation' ? 'Translation · English' : 'Transcript')
  assert.equal(callbacks.size, 1, 'App subscribes to Even events.')

  console.log(`Streaming ${(pcm.length / 32000).toFixed(1)} seconds through SDK audio events and main.ts to ${url}`)
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    emit('audioEvent', { audioPcm: [...pcm.subarray(offset, offset + 3200)] })
    audioEvents++
    await sleep(100)
  }
  assert.equal(pcmBytes, pcm.length, 'All injected PCM reaches the real speech socket.')
  await until(() => expected.test(phoneText()), 'recognized speech appears in phone UI')
  await until(() => upgrades.some(update => expected.test(update.content)), 'recognized speech reaches a glasses text update')

  emit('sysEvent', { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT })
  await until(() => !microphone, 'foreground exit turns the microphone off')
  await until(() => finishAcknowledgments > 0, 'foreground exit gracefully flushes WhisperLiveKit')
  await until(() => expected.test(phoneText()), 'recognized speech appears in phone UI')
  await until(() => upgrades.some(update => expected.test(update.content)), 'recognized speech reaches a glasses text update')
  assert.equal(finishFrames, 1, 'One empty binary frame ends the recording.')

  const lastUpgrade = upgrades.at(-1)
  console.log(JSON.stringify({
    passed: true,
    environment: 'jsdom with native microphone and glasses bridge stubbed; physical G2 not tested',
    serverUrl: url,
    outputMode,
    audioEvents,
    pcmBytes,
    finishFrames,
    finishAcknowledgments,
    phoneText: phoneText().trim(),
    glassesText: lastUpgrade?.content?.trim(),
    glassesUpdates: upgrades.length,
    microphoneStopped: !microphone,
  }, null, 2))
} finally {
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
  for (const socket of sockets) socket.close()
  // Allow main.ts's serial bridge cleanup to settle before removing window.
  await sleep(50)
  dom.window.close()
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  rmSync(temp, { recursive: true, force: true })
}
