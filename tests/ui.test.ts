import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { DEFAULT_SETTINGS, type AppSettings } from '../src/settings.ts'
import { mountUi, setOutputMode, setStatus, setTranslation } from '../src/ui.ts'

// The SDK bridge is not needed to exercise the phone settings and text mirror.
// Each test gets a fresh document, while interactions use the actual UI handlers.
describe('WhisperLiveKit phone UI', { concurrency: false }, () => {
  let dom: JSDOM
  let saves: AppSettings[]
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
      url: 'http://localhost:5173',
    })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
    saves = []
    mountUi({ settings: { ...DEFAULT_SETTINGS }, onSave: next => saves.push(next) })
  })

  afterEach(() => {
    dom.window.close()
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  function element<T extends HTMLElement>(selector: string): T {
    const found = dom.window.document.querySelector<T>(selector)
    assert.ok(found, `Expected ${selector} to exist`)
    return found
  }

  function save() {
    element<HTMLButtonElement>('#save').click()
  }

  test('first run opens connection setup and explains the server requirements', () => {
    assert.equal(element<HTMLDetailsElement>('#settings').open, true)
    assert.equal(element<HTMLInputElement>('#serverUrl').value, '')
    assert.equal(element<HTMLSelectElement>('#outputMode').value, 'transcript')
    assert.equal(element('#tl-label').textContent, 'Transcript')
    assert.equal(dom.window.document.querySelectorAll('section.pane').length, 1)
    assert.equal(dom.window.document.querySelector('input[type="password"]'), null)
    assert.match(element('#server-hint').textContent ?? '', /LAN address/)
    assert.match(element('#settings').textContent ?? '', /--direct-english-translation/)
    assert.equal(saves.length, 0)
  })

  test('invalid server URLs cannot be saved and produce an accessible visible error', () => {
    const input = element<HTMLInputElement>('#serverUrl')
    for (const invalid of ['not a URL', 'https://example.com/asr', 'ws://user:secret@example.com/asr']) {
      input.value = invalid
      save()
      assert.equal(saves.length, 0)
      const error = element<HTMLParagraphElement>('#server-error')
      assert.equal(error.hidden, false)
      assert.equal(error.getAttribute('role'), 'alert')
      assert.ok(error.textContent?.length)
      assert.equal(input.getAttribute('aria-invalid'), 'true')
      assert.equal(dom.window.document.activeElement, input)
      assert.equal(element<HTMLDetailsElement>('#settings').open, true)
    }

    input.value = 'ws://192.168.1.20:8000/asr'
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    assert.equal(element<HTMLParagraphElement>('#server-error').hidden, true)
    assert.equal(input.hasAttribute('aria-invalid'), false)
    save()
    assert.equal(saves.length, 1)
    assert.equal(saves[0].serverUrl, 'ws://192.168.1.20:8000/asr')
  })

  test('saving preserves all display choices and normalizes the connection URL', () => {
    element<HTMLInputElement>('#serverUrl').value = '  WSS://EXAMPLE.COM:443/asr  '
    element<HTMLSelectElement>('#outputMode').value = 'translation'
    element<HTMLInputElement>('#split').checked = false
    element<HTMLInputElement>('#speakers').checked = true
    element<HTMLSelectElement>('#align').value = 'center'
    element<HTMLSelectElement>('#valign').value = 'top'
    element<HTMLSelectElement>('#linegap').value = '2'
    element<HTMLSelectElement>('#width').value = '55'
    element<HTMLSelectElement>('#maxlines').value = '8'
    save()

    assert.deepEqual(saves, [{
      serverUrl: 'wss://example.com/asr',
      outputMode: 'translation',
      splitSentences: false,
      speakerLabels: true,
      align: 'center',
      vAlign: 'top',
      lineGap: 2,
      widthPct: 55,
      maxLines: 8,
    }])
    assert.equal(element<HTMLInputElement>('#serverUrl').value, 'wss://example.com/asr')
    assert.equal(element<HTMLDetailsElement>('#settings').open, false)
    assert.equal(element('#tl-label').textContent, 'Translation · English')
  })

  test('an empty endpoint remains a valid setup state', () => {
    save()
    assert.deepEqual(saves, [{ ...DEFAULT_SETTINGS }])
    assert.equal(element<HTMLDetailsElement>('#settings').open, true)
    assert.equal(element<HTMLParagraphElement>('#server-error').hidden, true)
  })

  test('output labels distinguish transcript from native English translation', () => {
    setOutputMode('translation')
    assert.equal(element('#tl-label').textContent, 'Translation · English')
    setOutputMode('transcript')
    assert.equal(element('#tl-label').textContent, 'Transcript')
  })

  test('streamed speech is rendered as plain text and replaces the previous snapshot', () => {
    const finalText = '<img src=x onerror="alert(1)"> & hello '
    const interimText = '<script>alert(2)</script>'
    setTranslation(finalText, interimText)
    assert.equal(element('#tl-final').textContent, finalText)
    assert.equal(element('#tl-interim').textContent, interimText)
    assert.equal(element('.pane-body').querySelector('img, script'), null)
    assert.equal(element('#tl-final').children.length, 0)
    assert.equal(element('#tl-interim').children.length, 0)

    setTranslation('Updated speech.', '')
    assert.equal(element('.pane-body').textContent, 'Updated speech.')
  })

  test('connection failures are readable on the page without hovering over a badge', () => {
    const message = 'Could not connect to WhisperLiveKit. Check the server URL.'
    setStatus('error', message)
    assert.equal(element('#status').textContent, 'Error')
    assert.ok(element('#status').classList.contains('status-error'))
    const details = element<HTMLParagraphElement>('#status-message')
    assert.equal(details.textContent, message)
    assert.equal(details.hidden, false)
    assert.equal(details.getAttribute('role'), 'status')
    assert.equal(details.getAttribute('aria-live'), 'polite')

    setStatus('listening', 'Microphone live')
    assert.equal(details.textContent, 'Microphone live')
    assert.equal(element('#status').textContent, 'Live')
  })
})
