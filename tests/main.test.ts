import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { evenHubEventFromJson, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

interface DisplayUpdate { containerName: string; content: string }
interface Page { containerTotalNum: number; textObject: Array<{ containerName: string; yPosition: number; height: number; paddingLength: number; isEventCapture: number }> }
interface PendingCue { signal?: AbortSignal; resolve: (response: Response) => void }

class FakeSocket extends EventTarget {
  static OPEN = 1
  static sockets: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: Uint8Array[] = []
  constructor(readonly url: string) { super(); FakeSocket.sockets.push(this) }
  config(sourceLanguage?: string) {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
    const url = new URL(this.url)
    this.message({ type: 'config', useAudioWorklet: true,
      source_language: sourceLanguage ?? url.searchParams.get('language'),
      translation_mode: url.searchParams.get('task') === 'translate' ? 'english' : 'transcript' })
  }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  transcript(text: string) { this.message({ lines: [{ speaker: 1, text }], buffer_transcription: '' }) }
  send(data: Uint8Array) { this.sent.push(data.slice()) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

test('full app routes SDK audio, session controls, captions, and AI lifecycle', { timeout: 30_000 }, async t => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost:5173' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const callbacks = new Set<(event: EvenHubEvent) => void>()
  const updates: DisplayUpdate[] = []
  const pages: Page[] = []
  const pendingCues: PendingCue[] = []
  const summaries: Array<{ transcript: string }> = []
  let microphone = false
  let shutdown = false
  let delayedRebuild: Promise<boolean> | undefined
  let delayedConfig: Promise<Response> | undefined
  let saved = JSON.stringify({ ...DEFAULT_SETTINGS, captionHoldSeconds: 3, serverUrl: 'ws://localhost:8000/asr' })
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const element = <T extends HTMLElement>(selector: string) => {
    const value = dom.window.document.querySelector<T>(selector)
    assert.ok(value, `Expected ${selector}`)
    return value
  }
  const phoneText = () => (element('#tl-final').textContent ?? '') + (element('#tl-interim').textContent ?? '')
  const lensText = () => updates.filter(update => update.containerName === 'output').at(-1)?.content.trim() ?? ''
  async function until(predicate: () => boolean, label: string, timeout = 2500) {
    const deadline = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
      await sleep(10)
    }
  }
  async function newConnection(action: () => void) {
    const previous = FakeSocket.sockets.length
    action()
    await until(() => FakeSocket.sockets.length > previous, 'new speech connection')
    return FakeSocket.sockets.at(-1)!
  }
  const emit = (type: string, jsonData: unknown) => {
    const event = evenHubEventFromJson({ type, jsonData })
    assert.ok(event, 'The actual SDK must decode the test event')
    for (const callback of callbacks) callback(event)
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  install('window', dom.window)
  install('document', dom.window.document)
  install('location', dom.window.location)
  install('WebSocket', FakeSocket)
  install('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/config')) {
      const pending = delayedConfig
      delayedConfig = undefined
      return pending ?? json({ configured: true, provider: 'Test provider', model: 'fixture' })
    }
    if (url.pathname.endsWith('/cue')) {
      return new Promise<Response>(resolve => pendingCues.push({ signal: init?.signal ?? undefined, resolve }))
    }
    if (url.pathname.endsWith('/summary')) {
      summaries.push(JSON.parse(String(init?.body)))
      return json({ summary: 'The group agreed to confirm the deadline.', action_items: ['Confirm the deadline.'] })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  Object.assign(dom.window, { EvenAppBridge: {
    _ready: true,
    async getLocalStorage() { return saved },
    async setLocalStorage(_key: string, value: string) { saved = value; return true },
    async createStartUpPageContainer(page: Page) { pages.push(page); return 0 },
    async rebuildPageContainer(page: Page) {
      pages.push(page)
      const pending = delayedRebuild
      delayedRebuild = undefined
      return pending ? await pending : true
    },
    async textContainerUpgrade(update: DisplayUpdate) { updates.push(update); return true },
    async audioControl(enabled: boolean) { microphone = enabled; return true },
    async shutDownPageContainer() { shutdown = true; return true },
    onEvenHubEvent(callback: (event: EvenHubEvent) => void) { callbacks.add(callback); return () => callbacks.delete(callback) },
  } })
  let socket: FakeSocket
  try {
    await import('../src/main.ts')
    await t.test('starts automatically after the acknowledged task and displays eight native-size caption lines', async () => {
      assert.equal(FakeSocket.sockets.length, 1)
      socket = FakeSocket.sockets[0]
      assert.equal(new URL(socket.url).searchParams.get('language'), 'auto')
      assert.equal(new URL(socket.url).searchParams.get('task'), 'translate')
      assert.equal(microphone, false, 'No microphone capture before the server confirms the request')
      const page = pages[0]
      assert.equal(page.containerTotalNum, 2)
      const output = page.textObject.find(container => container.containerName === 'output')!
      const header = page.textObject.find(container => container.containerName === 'direction')!
      assert.equal(header.yPosition, 0)
      assert.ok(header.height - 2 * header.paddingLength >= 27, 'The direction row has room for the native font')
      assert.equal(output.yPosition, 40)
      assert.equal(output.height, 248)
      assert.ok(header.yPosition + header.height <= output.yPosition)
      assert.equal(output.yPosition + output.height, 288)
      assert.equal(page.textObject.filter(container => container.isEventCapture === 1).length, 1)
      socket.config()
      await until(() => microphone, 'microphone starts automatically')
      emit('audioEvent', { audioPcm: [1, 2, 3, 4] })
      assert.deepEqual(socket.sent, [new Uint8Array([1, 2, 3, 4])])
      assert.equal(element('#session-toggle').textContent?.trim(), 'Pause')
      socket.transcript(Array.from({ length: 12 }, (_, i) => `Caption ${i + 1}.`).join(' '))
      await until(() => lensText().includes('Caption 12.'), 'expanded captions reach the glasses')
      assert.deepEqual(lensText().split('\n'), Array.from({ length: 8 }, (_, i) => `Caption ${i + 5}.`))
    })

    await t.test('timed captions clear, retained captions stay, and Pause clears only the lens', async () => {
      socket.transcript('First caption remains in the phone history.')
      await until(() => lensText().includes('phone history'), 'caption reaches glasses')
      await sleep(1500)
      socket.transcript('First caption remains in the phone history.')
      await until(() => lensText() === '', 'unchanged snapshots do not reset caption timer', 2000)
      assert.match(phoneText(), /phone history/)
      element<HTMLSelectElement>('#captionHold').value = '0'
      element<HTMLButtonElement>('#save').click()
      socket.transcript('Retained caption stays until it is replaced.')
      await until(() => lensText().includes('replaced'), 'retained caption reaches glasses')
      await sleep(3200)
      assert.match(lensText(), /replaced/)
      element<HTMLButtonElement>('#session-toggle').click()
      await until(() => !microphone && lensText() === '', 'Pause stops microphone and clears glasses')
      assert.match(phoneText(), /Retained caption/)
      const count = socket.sent.length
      emit('audioEvent', { audioPcm: [5, 6] })
      assert.equal(socket.sent.length, count, 'Paused audio events must not leave the app')
      element<HTMLButtonElement>('#session-toggle').click()
      await until(() => microphone, 'Resume restarts microphone')
    })

    await t.test('returning from the background keeps final speech and starts new anonymous voice numbering', async () => {
      emit('sysEvent', { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT })
      await until(() => !microphone && socket.sent.some(chunk => chunk.byteLength === 0), 'background speech drain begins')
      socket.transcript('Retained caption stays until it is replaced. Final words before leaving.')
      socket.message({ type: 'ready_to_stop' })
      assert.match(phoneText(), /Speaker 1:/)
      socket = await newConnection(() => emit('sysEvent', { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }))
      socket.config()
      await until(() => microphone, 'returning microphone starts after acknowledgment')
      socket.transcript('First speech after returning to the app.')
      assert.match(phoneText(), /Final words before leaving/)
      assert.match(phoneText(), /Speaker 2: First speech after returning/)
      assert.equal((phoneText().match(/Final words before leaving/g) ?? []).length, 1)
    })

    await t.test('manual source is explicitly requested and cannot start on a mismatched acknowledgment', async () => {
      const source = element<HTMLSelectElement>('#sourceLanguage')
      socket = await newConnection(() => { source.value = 'ru'; source.dispatchEvent(new dom.window.Event('change')) })
      assert.equal(new URL(socket.url).searchParams.get('language'), 'ru')
      const log = t.mock.method(console, 'error', () => {})
      socket.config('auto')
      await until(() => !microphone && socket.readyState === 3, 'mismatched source rejected')
      assert.match(element('#status-message').textContent ?? '', /did not confirm/)
      log.mock.restore()
      socket = await newConnection(() => element<HTMLButtonElement>('#save').click())
      socket.config('ru')
      await until(() => microphone, 'manual Russian acknowledged')
    })

    await t.test('Conversate requests transcription and rejects old speech or AI during a mode switch', async () => {
      const oldSocket = socket
      const previousCount = FakeSocket.sockets.length
      let finishRebuild: (result: boolean) => void = () => {}
      delayedRebuild = new Promise(resolve => { finishRebuild = resolve })
      element<HTMLButtonElement>('#mode-conversate').click()
      assert.equal(oldSocket.readyState, 3, 'Old speech must close before an asynchronous layout rebuild')
      oldSocket.transcript('STALE SPEECH DURING REBUILD')
      assert.doesNotMatch(phoneText(), /STALE/)
      finishRebuild(true)
      await until(() => FakeSocket.sockets.length > previousCount, 'Conversate connection after rebuild')
      socket = FakeSocket.sockets.at(-1)!
      assert.equal(new URL(socket.url).searchParams.get('task'), 'transcribe')
      const page = pages.at(-1)!
      assert.equal(page.containerTotalNum, 3, 'Conversate reserves a separate cue pane')
      const cue = page.textObject.find(container => container.containerName === 'cue')!
      const header = page.textObject.find(container => container.containerName === 'direction')!
      const output = page.textObject.find(container => container.containerName === 'output')!
      assert.equal(cue.yPosition, 0)
      assert.equal(cue.height - 2 * cue.paddingLength, 3 * 27, 'The AI pane fits three native-font lines')
      assert.ok(cue.yPosition + cue.height <= header.yPosition)
      assert.equal(header.yPosition, 90)
      assert.ok(header.yPosition + header.height <= output.yPosition)
      assert.equal(output.yPosition, 128)
      assert.equal(output.height, 160)
      assert.equal(output.yPosition + output.height, 288)
      socket.config()
      await until(() => microphone, 'Conversate microphone active')
      socket.transcript(Array.from({ length: 12 }, (_, i) => `Caption ${i + 1}.`).join(' '))
      await until(() => lensText().includes('Caption 12.'), 'five-line captions follow the mode change')
      assert.deepEqual(lensText().split('\n'), Array.from({ length: 5 }, (_, i) => `Caption ${i + 8}.`))
      await until(() => pendingCues.length === 1, 'AI request after committed speech')
      const stale = pendingCues[0]
      socket = await newConnection(() => element<HTMLButtonElement>('#mode-translate').click())
      assert.equal(new URL(socket.url).searchParams.get('task'), 'translate')
      assert.equal(stale.signal?.aborted, true)
      socket.config()
      stale.resolve(json({ kind: 'suggestion', text: 'STALE CUE MUST NOT APPEAR' }))
      await sleep(180)
      assert.doesNotMatch(element('#cue-text').textContent ?? '', /STALE/)
      assert.equal(updates.some(update => update.content.includes('STALE')), false)
    })

    await t.test('double-tap ends the session and drains final speech before requesting a summary', async () => {
      socket = await newConnection(() => element<HTMLButtonElement>('#mode-conversate').click())
      socket.config()
      await until(() => microphone, 'new Conversate session active')
      socket.transcript('We agreed to confirm the deadline after this meeting.')
      await until(() => pendingCues.length === 2, 'pending cue before End')
      const pending = pendingCues[1]
      emit('sysEvent', { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT })
      await until(() => !microphone && socket.sent.some(chunk => chunk.byteLength === 0), 'End sends binary finish')
      assert.equal(summaries.length, 0, 'Summary must wait for ready_to_stop')
      assert.equal(pending.signal?.aborted, true)
      pending.resolve(json({ kind: 'suggestion', text: 'LATE CUE AFTER END' }))
      socket.transcript('We agreed to confirm the deadline. The final word is FINALIZED.')
      await sleep(180)
      assert.equal(summaries.length, 0, 'Receiving final text alone is not completion')
      assert.doesNotMatch(element('#cue-text').textContent ?? '', /LATE/)
      socket.message({ type: 'ready_to_stop' })
      await until(() => summaries.length === 1, 'summary requested after drain acknowledgment')
      assert.match(summaries[0].transcript, /FINALIZED/)
      await until(() => !element('#conversation-summary').hidden, 'summary displayed')
      assert.equal(element('#action-items').children.length, 1)
      assert.equal(element<HTMLButtonElement>('#session-end').disabled, true)
      assert.equal(shutdown, false, 'Ending must leave the phone available for its summary')
      const finishCount = socket.sent.filter(chunk => chunk.byteLength === 0).length
      emit('sysEvent', { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT })
      await sleep(120)
      assert.equal(socket.sent.filter(chunk => chunk.byteLength === 0).length, finishCount)
      assert.equal(summaries.length, 1, 'Repeating End must not request another summary')
      assert.ok(callbacks.size > 0, 'The ended phone session stays mounted')
      assert.equal(microphone, false)
    })

    await t.test('display-only settings after End retain phone text and summary without opening speech', async () => {
      const textBeforeSave = phoneText()
      const summaryBeforeSave = element('#summary-text').textContent
      const connectionCount = FakeSocket.sockets.length
      element<HTMLSelectElement>('#captionHold').value = '5'
      element<HTMLButtonElement>('#save').click()
      await sleep(150)
      assert.equal(phoneText(), textBeforeSave)
      assert.equal(element('#summary-text').textContent, summaryBeforeSave)
      assert.equal(FakeSocket.sockets.length, connectionCount)
      assert.equal(element<HTMLButtonElement>('#session-end').disabled, true)
      assert.equal(microphone, false)
    })

    await t.test('End waits for delayed AI configuration and speech completion in either arrival order', async () => {
      for (const order of ['config-first', 'drain-first']) {
        let completeConfig!: (response: Response) => void
        delayedConfig = new Promise(resolve => { completeConfig = resolve })
        socket = await newConnection(() => element<HTMLButtonElement>('#session-toggle').click())
        socket.config()
        await until(() => microphone, 'speech starts while AI configuration is pending')
        socket.transcript(`The team will confirm the deadline for ${order}.`)
        const summaryCount = summaries.length
        element<HTMLButtonElement>('#session-end').click()
        await until(() => !microphone && socket.sent.some(chunk => chunk.byteLength === 0), 'End starts final drain')
        const finishSpeech = () => {
          socket.transcript(`The final agreement for ${order} is FINALIZED.`)
          socket.message({ type: 'ready_to_stop' })
        }
        const finishConfig = () => completeConfig(json({ configured: true, provider: 'Test provider', model: 'fixture' }))
        if (order === 'config-first') finishConfig()
        else finishSpeech()
        await sleep(150)
        assert.equal(summaries.length, summaryCount, 'Both AI readiness and speech completion are required')
        if (order === 'config-first') finishSpeech()
        else finishConfig()
        await until(() => summaries.length === summaryCount + 1, 'summary starts once both conditions hold')
        assert.match(summaries.at(-1)!.transcript, new RegExp(`${order} is FINALIZED`))
        await until(() => !element('#conversation-summary').hidden, 'delayed-provider summary displayed')
      }
    })
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
    await until(() => callbacks.size === 0, 'unloading cleans up SDK event handlers')
    assert.equal(socket.readyState, 3)
    assert.equal(microphone, false)
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
    await sleep(20)
    dom.window.close()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
