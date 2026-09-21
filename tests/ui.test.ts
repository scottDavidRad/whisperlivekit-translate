import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings } from '../src/settings.ts'
import { mountUi, setOutputMode, setStatus, setTranslation, setSessionState, setAppMode, setConversationCue, setConversationStatus, setConversationSummary, setSpeakerState, setSpeakerMessage, type SessionAction } from '../src/ui.ts'

// The SDK bridge is not needed to exercise the phone settings and text mirror.
// Each test gets a fresh document, while interactions use the actual UI handlers.
describe('WhisperLiveKit phone UI', { concurrency: false }, () => {
  let dom: JSDOM
  let saves: AppSettings[]
  let sessionActions: SessionAction[]
  let cueActions: number
  let enrolled: Array<[number, string]>
  let renamed: Array<[string, string]>
  let forgotten: string[]
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
      url: 'http://localhost:5173',
    })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
    saves = []
    sessionActions = []
    cueActions = 0
    enrolled = []
    renamed = []
    forgotten = []
    mountUi({ settings: { ...DEFAULT_SETTINGS }, onSave: next => saves.push(next), onSessionAction: action => sessionActions.push(action), onCueAction: () => cueActions++,
      onSpeakerEnroll: (speaker, name) => enrolled.push([speaker, name]), onSpeakerRename: (id, name) => renamed.push([id, name]), onSpeakerForget: id => forgotten.push(id) })
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
    assert.equal(element<HTMLSelectElement>('#outputMode').value, 'translation')
    assert.equal(element('#tl-label').textContent, 'Translation · English')
    assert.equal(element<HTMLInputElement>('#speakers').checked, true)
    assert.match(element('#language-hint').textContent ?? '', /Auto detects/)
    assert.equal(dom.window.document.querySelectorAll('section.pane').length, 1)
    assert.equal(dom.window.document.querySelector('input[type="password"]'), null)
    assert.match(element('#server-hint').textContent ?? '', /LAN address/)
    assert.match(element('#language-hint').textContent ?? '', /Conversate keeps the original speech/)
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
    element<HTMLInputElement>('#speakers').checked = false
    element<HTMLSelectElement>('#align').value = 'center'
    element<HTMLSelectElement>('#valign').value = 'top'
    element<HTMLSelectElement>('#linegap').value = '2'
    element<HTMLSelectElement>('#width').value = '55'
    element<HTMLSelectElement>('#maxlines').value = '8'
    save()

    assert.deepEqual(saves, [{
      ...DEFAULT_SETTINGS,
      serverUrl: 'wss://example.com/asr',
      sourceLanguage: 'auto',
      outputMode: 'translation',
      splitSentences: false,
      speakerLabels: false,
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
    assert.equal(element('#tl-final').querySelector('img, script'), null)
    assert.equal(element('#tl-interim').children.length, 0)

    setTranslation('Updated speech.', '')
    assert.equal(element('#tl-final').textContent, 'Updated speech.')
    assert.equal(element('#empty-transcript').hidden, true)
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

  test('Auto starts selected with no start action and a read-only English target', () => {
    assert.equal(element('h1').textContent, 'Translate')
    assert.equal(element<HTMLSelectElement>('#sourceLanguage').value, 'auto')
    assert.equal(element('#target-language').textContent, 'English')
    assert.equal(element('#target-language').tagName, 'SPAN')
    assert.match(element('#session-toggle').textContent ?? '', /Pause/)
    assert.deepEqual(sessionActions, [])
  })

  test('manual source selection saves immediately and can return to Auto', () => {
    const source = element<HTMLSelectElement>('#sourceLanguage')
    source.value = 'ru'
    source.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    assert.equal(saves.at(-1)?.sourceLanguage, 'ru')
    assert.equal(saves.at(-1)?.outputMode, 'translation')
    assert.match(element('#source-hint').textContent ?? '', /Russian/)
    source.value = 'auto'
    source.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    assert.equal(saves.at(-1)?.sourceLanguage, 'auto')
    assert.match(element('#source-hint').textContent ?? '', /Automatic/)
  })

  test('settings button opens and closes the actual settings panel', () => {
    const button = element<HTMLButtonElement>('#settings-toggle')
    button.click()
    assert.equal(element<HTMLDetailsElement>('#settings').open, false)
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    button.click()
    assert.equal(element<HTMLDetailsElement>('#settings').open, true)
    assert.equal(button.getAttribute('aria-expanded'), 'true')
  })

  test('Pause, Resume, End, and Start invoke session actions without pretending they completed', () => {
    const toggle = element<HTMLButtonElement>('#session-toggle')
    const end = element<HTMLButtonElement>('#session-end')
    toggle.click()
    assert.deepEqual(sessionActions, ['pause'])
    assert.match(toggle.textContent ?? '', /Pause/)
    setSessionState('paused')
    assert.match(toggle.textContent ?? '', /Resume/)
    assert.equal(element('#status').textContent, 'Paused')
    toggle.click()
    assert.deepEqual(sessionActions, ['pause', 'resume'])
    setSessionState('listening')
    end.click()
    assert.equal(sessionActions.at(-1), 'end')
    setSessionState('ended')
    assert.equal(end.disabled, true)
    assert.match(toggle.textContent ?? '', /Start/)
    end.click()
    assert.deepEqual(sessionActions, ['pause', 'resume', 'end'])
    toggle.click()
    assert.equal(sessionActions.at(-1), 'start')
  })

  test('speaker rows preserve exact snapshot text for copying and integration consumers', () => {
    const text = 'Speaker 1: Hello.\nSpeaker 2: Good morning.'
    setTranslation(text, '\nSpeaker pending: Next')
    assert.equal(element('#tl-final').textContent, text)
    assert.equal(element('#tl-interim').textContent, '\nSpeaker pending: Next')
    assert.equal(element('#tl-final').querySelectorAll('.speaker-label').length, 2)
    setTranslation('', '')
    assert.equal(element('#tl-final').textContent, '')
    assert.equal(element('#empty-transcript').hidden, false)
  })


  test('Conversate mode is optional, saves immediately, and shows cues without inventing a target language', () => {
    assert.equal(element('#conversation-panel').hidden, true)
    element<HTMLButtonElement>('#mode-conversate').click()
    assert.equal(saves.at(-1)?.appMode, 'conversate')
    assert.equal(element('h1').textContent, 'Conversate')
    assert.equal(element('#conversation-panel').hidden, false)
    assert.equal(element('#conversation-settings').hidden, false)
    assert.equal(element('#source-label').textContent, 'Speech language')
    assert.ok(element('.language-pair').classList.contains('source-only'))
    assert.equal(element('#mode-conversate').getAttribute('aria-pressed'), 'true')
    element<HTMLButtonElement>('#mode-translate').click()
    assert.equal(saves.at(-1)?.appMode, 'translate')
    assert.equal(element('#conversation-panel').hidden, true)
  })

  test('real AI cues, provider status, and summary are rendered safely and the cue action is explicit', () => {
    setAppMode('conversate')
    const cueButton = element<HTMLButtonElement>('#show-cue')
    assert.equal(cueButton.disabled, true)
    setConversationStatus('AI provider is not configured.')
    assert.equal(element('#conversation-status').textContent, 'AI provider is not configured.')
    setConversationCue({ kind: 'Suggestion', text: '<img src=x> Ask about the deadline.' })
    assert.equal(element('#cue-text').textContent, '<img src=x> Ask about the deadline.')
    assert.equal(element('#cue-text').querySelector('img'), null)
    assert.equal(cueButton.disabled, false)
    cueButton.click()
    assert.equal(cueActions, 1)
    setConversationSummary('We agreed to <review> the plan.', ['Confirm timing.', '<script>bad()</script>'])
    assert.equal(element('#conversation-summary').hidden, false)
    assert.equal(element('#summary-text').textContent, 'We agreed to <review> the plan.')
    assert.equal(element('#action-items').children.length, 2)
    assert.equal(element('#action-items').querySelector('script'), null)
    setConversationCue(null)
    assert.equal(cueButton.disabled, true)
    setConversationSummary('', [])
    assert.equal(element('#conversation-summary').hidden, true)
  })

  test('prep notes, cue preferences, and both caption retention options save independently', () => {
    element<HTMLButtonElement>('#mode-conversate').click()
    const prep = element<HTMLTextAreaElement>('#prepNotes')
    assert.equal(prep.maxLength, 5000)
    prep.value = 'Discuss the project timeline.'
    element<HTMLInputElement>('#cueAutoShow').checked = false
    element<HTMLSelectElement>('#cueDuration').value = '30'
    const hold = element<HTMLSelectElement>('#captionHold')
    assert.equal(hold.value, '5')
    assert.equal(hold.options[0].text, 'Stay until replaced')
    hold.value = '0'
    save()
    assert.equal(saves.at(-1)?.prepNotes, 'Discuss the project timeline.')
    assert.equal(saves.at(-1)?.cueAutoShow, false)
    assert.equal(saves.at(-1)?.cueDurationSeconds, 30)
    assert.equal(saves.at(-1)?.captionHoldSeconds, 0)
    hold.value = '15'
    prep.value = 'a'.repeat(5100)
    save()
    assert.equal(saves.at(-1)?.captionHoldSeconds, 15)
    assert.equal(saves.at(-1)?.prepNotes.length, 5000)
  })


  test('Conversate provider choices persist without exposing credential inputs', () => {
    element<HTMLButtonElement>('#mode-conversate').click()
    const provider = element<HTMLSelectElement>('#aiProvider')
    assert.equal(provider.value, 'codex')
    assert.deepEqual(Array.from(provider.options, option => option.text), ['Codex', 'Grok', 'Qwen 3.8', 'OpenAI-compatible'])
    for (const value of ['grok', 'qwen', 'openai-compatible', 'codex']) {
      provider.value = value
      save()
      assert.equal(saves.at(-1)?.aiProvider, value)
    }
    assert.equal(dom.window.document.querySelector('input[type="password"]'), null)
  })

  test('saved voice recognition defaults on and persists only a boolean preference', () => {
    assert.equal(DEFAULT_SETTINGS.rememberSpeakers, true)
    assert.equal(mergeSettings(JSON.stringify({ rememberSpeakers: false })).rememberSpeakers, false)
    assert.equal(mergeSettings(JSON.stringify({ rememberSpeakers: 'false' })).rememberSpeakers, true)
    assert.equal(element<HTMLInputElement>('#rememberSpeakers').checked, true)
    element<HTMLInputElement>('#rememberSpeakers').checked = false
    save()
    assert.equal(saves.at(-1)?.rememberSpeakers, false)
    assert.match(element('#speaker-status').textContent ?? '', /recognition is off/)
    assert.equal(element('#speaker-panel').closest('#settings'), null)
    assert.match(element('#speaker-panel').textContent ?? '', /Select a current speaker and enter their name/)
    assert.doesNotMatch(element('#speaker-panel').textContent ?? '', /Say “Person/)
  })

  test('naming a current voice sends its display number and a normalized Unicode name', () => {
    setSpeakerState({ status: 'ready', speakers: [{ speaker: 7, seconds: 2.75 }], profiles: [] })
    assert.equal(element<HTMLSelectElement>('#current-speaker').selectedOptions[0].textContent, 'Speaker 7')
    assert.match(element('#speaker-audio').textContent ?? '', /2\.8 seconds collected/)
    assert.equal(element<HTMLButtonElement>('#speaker-enroll').disabled, false, 'The backend decides whether enough clean audio exists')
    assert.equal(element('#speaker-name-hint').hidden, true)
    const input = element<HTMLInputElement>('#speaker-name')
    assert.equal(input.maxLength, 40)
    input.value = '  Jose\u0301   O’Neill  '
    element<HTMLButtonElement>('#speaker-enroll').click()
    assert.deepEqual(enrolled, [[7, 'José O’Neill']])
    setSpeakerState({ status: 'ready', speakers: [{ speaker: 7, name: 'José O’Neill', profileId: 'voice-7', seconds: 4 }], profiles: [{ id: 'voice-7', name: 'José O’Neill' }] })
    assert.equal(element('#speaker-enroll').textContent, 'Assign another person')
    assert.equal(element('#speaker-name-hint').hidden, false)
    assert.match(element('#speaker-name-hint').textContent ?? '', /change only a saved name, use Rename below/)
    assert.equal(element<HTMLSelectElement>('#current-speaker').selectedOptions[0].textContent, 'Speaker 7 — José O’Neill')
    input.value = 'Иван'
    element<HTMLButtonElement>('#speaker-enroll').click()
    assert.deepEqual(enrolled.at(-1), [7, 'Иван'])
  })

  test('live speaker updates preserve selections, focused edits, and caret position', () => {
    const state = { status: 'ready' as const, speakers: [{ speaker: 1, seconds: 3 }, { speaker: 2, name: 'Anna', seconds: 5 }], profiles: [{ id: 'one', name: 'John' }, { id: 'two', name: 'Anna' }] }
    setSpeakerState(state)
    const select = element<HTMLSelectElement>('#current-speaker')
    select.value = '2'
    select.dispatchEvent(new dom.window.Event('change'))
    const input = element<HTMLInputElement>('#speaker-name')
    input.focus()
    input.value = 'Anna Maria'
    input.dispatchEvent(new dom.window.Event('input'))
    input.setSelectionRange(4, 4)
    setSpeakerState({ ...state, speakers: [...state.speakers.map(voice => ({ ...voice, seconds: voice.seconds + 1 })), { speaker: 3, seconds: 0.5 }] })
    assert.equal(select.value, '2')
    assert.equal(input.value, 'Anna Maria')
    assert.equal(dom.window.document.activeElement, input)
    assert.equal(input.selectionStart, 4)
    const savedSelect = element<HTMLSelectElement>('#saved-speaker')
    savedSelect.value = 'two'
    savedSelect.dispatchEvent(new dom.window.Event('change'))
    const savedInput = element<HTMLInputElement>('#profile-name')
    savedInput.focus()
    savedInput.value = 'Анна'
    savedInput.dispatchEvent(new dom.window.Event('input'))
    setSpeakerState(state)
    assert.equal(savedSelect.value, 'two')
    assert.equal(savedInput.value, 'Анна')
    element<HTMLButtonElement>('#speaker-rename').click()
    assert.deepEqual(renamed, [['two', 'Анна']])
  })

  test('invalid voice names are rejected visibly and external names remain plain text', () => {
    const unsafe = '<img src=x onerror=alert(1)>'
    setSpeakerState({ status: 'ready', speakers: [{ speaker: 1, name: unsafe, seconds: 3 }], profiles: [{ id: 'safe-id', name: unsafe }] })
    assert.equal(element('#speaker-panel').querySelector('img'), null)
    assert.match(element<HTMLSelectElement>('#saved-speaker').textContent ?? '', /<img/)
    const input = element<HTMLInputElement>('#speaker-name')
    for (const value of ['', unsafe, 'John\nSpeaker 2', 'A'.repeat(41), 'Speaker']) {
      input.value = value
      element<HTMLButtonElement>('#speaker-enroll').click()
      assert.equal(input.getAttribute('aria-invalid'), 'true')
      assert.equal(element('#speaker-message').hidden, false)
    }
    assert.deepEqual(enrolled, [])
    setSpeakerMessage('<script>Unavailable</script>')
    assert.equal(element('#speaker-message').textContent, '<script>Unavailable</script>')
    assert.equal(element('#speaker-message').querySelector('script'), null)
  })

  test('forgetting a saved voice requires a second confirmation and supports cancellation', () => {
    setSpeakerState({ status: 'ready', speakers: [], profiles: [{ id: 'john-id', name: 'John' }, { id: 'anna-id', name: 'Anna' }] })
    element<HTMLButtonElement>('#speaker-forget').click()
    assert.deepEqual(forgotten, [])
    assert.equal(element('#speaker-forget-confirmation').hidden, false)
    assert.match(element('#speaker-forget-prompt').textContent ?? '', /John/)
    element<HTMLButtonElement>('#speaker-forget-cancel').click()
    element<HTMLButtonElement>('#speaker-forget-confirm').click()
    assert.deepEqual(forgotten, [])
    element<HTMLButtonElement>('#speaker-forget').click()
    const select = element<HTMLSelectElement>('#saved-speaker')
    select.value = 'anna-id'
    select.dispatchEvent(new dom.window.Event('change'))
    assert.equal(element('#speaker-forget-confirmation').hidden, true)
    element<HTMLButtonElement>('#speaker-forget-confirm').click()
    assert.deepEqual(forgotten, [])
    element<HTMLButtonElement>('#speaker-forget').click()
    element<HTMLButtonElement>('#speaker-forget-confirm').click()
    assert.deepEqual(forgotten, ['anna-id'])
    assert.equal(element('#speaker-forget-confirmation').hidden, true)
    element<HTMLButtonElement>('#speaker-forget-confirm').click()
    assert.deepEqual(forgotten, ['anna-id'])
  })

  test('speaker actions follow session state and unavailable or disabled backend status', () => {
    const state = { status: 'ready' as const, speakers: [{ speaker: 1, name: 'John', seconds: 4 }], profiles: [{ id: 'john-id', name: 'John' }] }
    setSpeakerState(state)
    setSessionState('paused')
    assert.equal(element<HTMLButtonElement>('#speaker-enroll').disabled, true)
    assert.equal(element<HTMLButtonElement>('#speaker-rename').disabled, false)
    element<HTMLInputElement>('#profile-name').value = 'Johnny'
    element<HTMLButtonElement>('#speaker-rename').click()
    assert.deepEqual(renamed, [['john-id', 'Johnny']])
    setSessionState('ended')
    element<HTMLButtonElement>('#speaker-enroll').click()
    assert.deepEqual(enrolled, [])
    setSessionState('listening')
    assert.equal(element<HTMLButtonElement>('#speaker-enroll').disabled, false)
    element<HTMLButtonElement>('#speaker-forget').click()
    setSpeakerState({ ...state, status: 'unavailable', message: 'This older server cannot save voices.' })
    assert.equal(element('#speaker-status').textContent, 'This older server cannot save voices.')
    assert.equal(element('#speaker-forget-confirmation').hidden, true)
    for (const id of ['speaker-enroll', 'speaker-rename', 'speaker-forget']) assert.equal(element<HTMLButtonElement>(`#${id}`).disabled, true)
    setSpeakerState({ ...state, status: 'disabled' })
    assert.match(element('#speaker-status').textContent ?? '', /recognition is off/)
  })

  test('named caption labels preserve Unicode and exact copied text without HTML parsing', () => {
    const text = 'José O’Neill: Hello.\nАнна-Мария: Добрый день.\nSpeaker 3: Welcome.\n<img>: Plain text.'
    setTranslation(text, ' interim')
    assert.equal(element('#tl-final').textContent, text)
    assert.deepEqual(Array.from(element('#tl-final').querySelectorAll('.speaker-label'), label => label.textContent), ['José O’Neill:', 'Анна-Мария:', 'Speaker 3:'])
    assert.equal(element('#tl-final').querySelector('img'), null)
  })

})
