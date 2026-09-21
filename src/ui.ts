import { LANGUAGES, langName } from './languages'
import { validateServerUrl, type AppSettings, type OutputMode } from './settings'
import { normalizeSpeakerName, type SpeakerState } from './speakers'

type Status = 'connecting' | 'listening' | 'error' | 'setup' | 'reconnecting'
export type SessionState = 'listening' | 'paused' | 'ended'
export type SessionAction = 'pause' | 'resume' | 'end' | 'start'

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting', listening: 'Live', reconnecting: 'Reconnecting', error: 'Error', setup: 'Setup',
}

let statusEl: HTMLElement
let statusMessageEl: HTMLParagraphElement
let tlFinalEl: HTMLElement
let tlInterimEl: HTMLElement
let tlLabelEl: HTMLElement
let emptyEl: HTMLElement
let pauseEl: HTMLButtonElement
let endEl: HTMLButtonElement
let transcriptEl: HTMLElement
let sessionState: SessionState = 'listening'
let appMode: 'translate' | 'conversate' = 'translate'
let currentOutputMode: OutputMode = 'translation'
let conversationPanelEl: HTMLElement
let conversationSettingsEl: HTMLElement
let conversationStatusEl: HTMLElement
let cueKindEl: HTMLElement
let cueTextEl: HTMLElement
let cueButtonEl: HTMLButtonElement
let summaryEl: HTMLElement
let summaryTextEl: HTMLElement
let actionItemsEl: HTMLElement
let hasSummary = false
let canShowCue = false
let speakerState: SpeakerState = { status: 'loading', speakers: [], profiles: [] }
let renderSpeakerControls = () => {}

const icons = {
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  translate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h11M8 3v2m4 0c-1 6-4 9-9 11m2-8c1 4 4 7 8 9m1 4 4-11 4 11m-6-4h5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M16 4v16"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 12 8-12 8Z"/></svg>',
  end: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16M20 4 4 20"/></svg>',
}

export interface UiHandlers {
  settings: AppSettings
  onSave: (next: AppSettings) => void
  onSessionAction: (action: SessionAction) => void
  onCueAction?: () => void
  onSpeakerEnroll?: (speaker: number, name: string) => void
  onSpeakerRename?: (profileId: string, name: string) => void
  onSpeakerForget?: (profileId: string) => void
}

export function mountUi({ settings, onSave, onSessionAction, onCueAction, onSpeakerEnroll, onSpeakerRename, onSpeakerForget }: UiHandlers) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  let currentSettings = { ...settings }
  const opt = (n: number, label: string, selected: number) =>
    `<option value="${n}"${n === selected ? ' selected' : ''}>${label}</option>`
  const languageOptions = LANGUAGES.map(language =>
    `<option value="${escapeAttr(language.code)}"${language.code === settings.sourceLanguage ? ' selected' : ''}>${escapeAttr(language.code === 'auto' ? 'Auto' : language.name)}</option>`,
  ).join('')

  app.innerHTML = `
    <main class="panel">
      <header class="topbar">
        <span class="app-mark" aria-hidden="true">${icons.translate}</span>
        <h1>Translate</h1>
        <button id="settings-toggle" class="icon-button" type="button" aria-label="Settings"
          aria-controls="settings" aria-expanded="${!settings.serverUrl}">${icons.settings}</button>
      </header>

      <nav class="mode-tabs" aria-label="App mode">
        <button id="mode-translate" type="button" aria-pressed="true">Translate</button>
        <button id="mode-conversate" type="button" aria-pressed="false">Conversate</button>
      </nav>
      <section class="language-pair" aria-label="Translation languages">
        <div class="language-side">
          <label id="source-label" for="sourceLanguage">From</label>
          <select id="sourceLanguage" aria-describedby="source-hint">${languageOptions}</select>
        </div>
        <span class="language-arrow">${icons.arrow}</span>
        <div class="language-side language-target">
          <span class="language-caption">To</span>
          <span id="target-language" aria-label="Translation target: English">English</span>
        </div>
      </section>
      <p id="source-hint" class="source-hint">${sourceHint(settings.sourceLanguage)}</p>

      <details id="settings" class="settings"${settings.serverUrl ? '' : ' open'}>
        <summary>Settings</summary>
        <div class="group-title">Connection</div>
        <div class="field">
          <label for="serverUrl">WhisperLiveKit server URL</label>
          <input id="serverUrl" type="url" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder="ws://&lt;computer LAN IP&gt;:8000/asr" value="${escapeAttr(settings.serverUrl)}"
            aria-describedby="server-hint server-error" />
          <p id="server-hint" class="hint">Use the server's LAN address or private secure endpoint.
            HTTPS pages require wss://. A preconfigured app connects automatically.</p>
          <p id="server-error" class="field-error" role="alert" hidden></p>
        </div>
        <div id="output-mode-field" class="field">
          <label for="outputMode">Display output</label>
          <select id="outputMode">
            <option value="translation"${settings.outputMode === 'translation' ? ' selected' : ''}>English translation</option>
            <option value="transcript"${settings.outputMode === 'transcript' ? ' selected' : ''}>Transcript</option>
          </select>
          <p id="language-hint" class="hint">Auto detects supported speech languages. Translate shows English;
            Conversate keeps the original speech.</p>
        </div>
        <div class="group-title">Glasses display</div>
        <p class="hint">Glasses show confirmed speech on steady pages. Live wording stays on the phone.</p>
        <div class="row">
          <div class="field"><label for="align">Alignment</label><select id="align">
            <option value="left"${settings.align === 'left' ? ' selected' : ''}>Left</option>
            <option value="center"${settings.align === 'center' ? ' selected' : ''}>Center</option>
          </select></div>
          <div class="field"><label for="valign">Anchor</label><select id="valign">
            <option value="bottom"${settings.vAlign === 'bottom' ? ' selected' : ''}>Bottom</option>
            <option value="top"${settings.vAlign === 'top' ? ' selected' : ''}>Top</option>
          </select></div>
          <div class="field"><label for="linegap">Line spacing</label><select id="linegap">
            ${opt(0, 'Normal', settings.lineGap)}${opt(1, 'Relaxed', settings.lineGap)}${opt(2, 'Loose', settings.lineGap)}
          </select></div>
          <div class="field"><label for="width">Text width</label><select id="width">
            ${opt(100, 'Full', settings.widthPct)}${opt(85, 'Wide', settings.widthPct)}${opt(70, 'Medium', settings.widthPct)}${opt(55, 'Narrow', settings.widthPct)}
          </select></div>
          <div class="field"><label for="maxlines">Max lines</label><select id="maxlines">
            ${[0, 1, 2, 3, 4, 5, 6, 8].map(n => opt(n, n === 0 ? 'Auto' : String(n), settings.maxLines)).join('')}
          </select></div>
        </div>
        <div class="field">
          <label for="captionHold">Clear captions after</label>
          <select id="captionHold">${[0, 3, 5, 10, 15].map(n => opt(n, n === 0 ? 'Stay until replaced' : `${n} seconds`, settings.captionHoldSeconds)).join('')}</select>
          <p class="hint">After the last displayed caption update. Pausing clears the glasses immediately; phone history stays.</p>
        </div>
        <label class="check"><input id="split" type="checkbox"${settings.splitSentences ? ' checked' : ''}/> Split sentences onto new lines</label>
        <label class="check"><input id="speakers" type="checkbox"${settings.speakerLabels ? ' checked' : ''}/> Identify speakers</label>
        <p class="hint">Unrecognized voices use Speaker 1, Speaker 2, or pending labels.</p>
        <label class="check"><input id="rememberSpeakers" type="checkbox"${settings.rememberSpeakers ? ' checked' : ''}/> Recognize saved voices</label>
        <p class="hint">Saved voice profiles stay on the backend computer. Rename or forget them in Speakers below.</p>
        <div id="conversation-settings" hidden>
          <div class="group-title">Conversate</div>
          <div class="field"><label for="aiProvider">AI provider</label><select id="aiProvider">
            ${[['codex', 'Codex'], ['grok', 'Grok'], ['qwen', 'Qwen 3.8'], ['openai-compatible', 'OpenAI-compatible']].map(([value, label]) => `<option value="${value}"${settings.aiProvider === value ? ' selected' : ''}>${label}</option>`).join('')}
          </select></div>
          <div class="field">
            <label for="prepNotes">Prep notes <span class="optional">Optional</span></label>
            <textarea id="prepNotes" maxlength="5000" rows="4" placeholder="Background, questions, or talking points">${escapeAttr(settings.prepNotes)}</textarea>
          </div>
          <label class="check"><input id="cueAutoShow" type="checkbox"${settings.cueAutoShow ? ' checked' : ''}/> Auto pop-up AI cues</label>
          <div class="field"><label for="cueDuration">Cue duration</label><select id="cueDuration">
            ${[5, 10, 15, 30].map(n => opt(n, `${n} seconds`, settings.cueDurationSeconds)).join('')}
          </select></div>
        </div>
        <div class="actions">
          <button id="save" type="button" class="primary">Save</button>
          <span id="saved" class="saved" role="status"></span>
        </div>
      </details>

      <section id="conversation-panel" class="conversation-panel" aria-label="AI Cues" hidden>
        <div class="pane-head"><h2>AI Cues</h2><button id="show-cue" type="button" class="text-button" disabled>Show on glasses</button></div>
        <p id="conversation-status" class="hint" role="status" aria-live="polite">Waiting for conversation context.</p>
        <div id="cue-kind" class="cue-kind" hidden></div>
        <p id="cue-text" class="cue-text" aria-live="polite">Cues will appear here during your conversation.</p>
      </section>
      <section class="pane pane-primary" aria-label="Live translation">
        <div class="pane-head">
          <div id="tl-label" class="pane-label">Translation · English</div>
          <div class="pane-tools">
            <span id="status" class="status status-connecting">Connecting</span>
            <button id="copyTl" type="button" class="text-button">Copy</button>
          </div>
        </div>
        <p id="status-message" class="status-message" role="status" aria-live="polite">Connecting…</p>
        <div class="pane-body" role="log" aria-live="polite" aria-relevant="text additions">
          <div id="empty-transcript" class="empty-transcript"><p>Listening…</p><span>Speak naturally. Translation appears here.</span></div>
          <div id="tl-final" class="transcript-final"></div><div id="tl-interim" class="interim"></div>
        </div>
      </section>

      <section id="speaker-panel" class="conversation-panel" aria-label="Speakers">
        <h2>Speakers</h2>
        <p class="hint">Select a current speaker and enter their name. Saved voices are matched during future conversations.</p>
        <p id="speaker-status" class="speaker-status hint" role="status" aria-live="polite"></p>
        <div class="row">
          <div class="field"><label for="current-speaker">Current voice</label><select id="current-speaker"></select></div>
          <div class="field"><label for="speaker-name">Name</label><input id="speaker-name" maxlength="40" autocomplete="off" aria-describedby="speaker-audio speaker-name-hint speaker-message" /></div>
        </div>
        <p id="speaker-audio" class="hint"></p>
        <div class="speaker-actions"><button id="speaker-enroll" class="primary" type="button" disabled>Remember voice</button></div>
        <p id="speaker-name-hint" class="hint" hidden>To change only a saved name, use Rename below.</p>
        <h3>Saved voices</h3>
        <div class="row">
          <div class="field"><label for="saved-speaker">Voice profile</label><select id="saved-speaker"></select></div>
          <div class="field"><label for="profile-name">Name</label><input id="profile-name" maxlength="40" autocomplete="off" aria-describedby="speaker-message" /></div>
        </div>
        <div class="speaker-actions">
          <button id="speaker-rename" class="secondary" type="button" disabled>Rename</button>
          <button id="speaker-forget" class="secondary" type="button" disabled>Forget</button>
        </div>
        <div id="speaker-forget-confirmation" class="forget-confirmation" hidden>
          <p id="speaker-forget-prompt" class="hint"></p>
          <div class="speaker-actions">
            <button id="speaker-forget-confirm" class="secondary" type="button">Forget saved voice</button>
            <button id="speaker-forget-cancel" class="secondary" type="button">Cancel</button>
          </div>
        </div>
        <p id="speaker-message" class="speaker-status hint" role="status" aria-live="polite" hidden></p>
      </section>

      <section id="conversation-summary" class="conversation-panel" aria-label="Conversation summary" hidden>
        <h2>AI Summary</h2><p id="summary-text" class="summary-text"></p>
        <h3 id="action-items-title">Action Items</h3><ul id="action-items"></ul>
      </section>
      <footer class="session-bar" aria-label="Translation session controls">
        <button id="session-toggle" type="button" class="session-button">${icons.pause}<span>Pause</span></button>
        <button id="session-end" type="button" class="session-button">${icons.end}<span>End</span></button>
      </footer>
    </main>
  `

  const $ = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!
  statusEl = $('#status')
  statusMessageEl = $('#status-message')
  tlFinalEl = $('#tl-final')
  tlInterimEl = $('#tl-interim')
  tlLabelEl = $('#tl-label')
  emptyEl = $('#empty-transcript')
  transcriptEl = $('.pane-body')
  pauseEl = $('#session-toggle')
  endEl = $('#session-end')
  conversationPanelEl = $('#conversation-panel')
  conversationSettingsEl = $('#conversation-settings')
  conversationStatusEl = $('#conversation-status')
  cueKindEl = $('#cue-kind')
  cueTextEl = $('#cue-text')
  cueButtonEl = $('#show-cue')
  summaryEl = $('#conversation-summary')
  summaryTextEl = $('#summary-text')
  actionItemsEl = $('#action-items')
  hasSummary = false
  canShowCue = Boolean(onCueAction)
  speakerState = { status: settings.rememberSpeakers ? 'loading' : 'disabled', speakers: [], profiles: [] }
  const currentSpeakerEl = $<HTMLSelectElement>('#current-speaker')
  const speakerNameEl = $<HTMLInputElement>('#speaker-name')
  const savedSpeakerEl = $<HTMLSelectElement>('#saved-speaker')
  const profileNameEl = $<HTMLInputElement>('#profile-name')
  const enrollEl = $<HTMLButtonElement>('#speaker-enroll')
  const renameEl = $<HTMLButtonElement>('#speaker-rename')
  const forgetEl = $<HTMLButtonElement>('#speaker-forget')
  const forgetConfirmationEl = $('#speaker-forget-confirmation')
  let speakerNameEdited = false
  let profileNameEdited = false
  let forgetProfileId = ''
  const dismissForget = () => { forgetProfileId = ''; forgetConfirmationEl.hidden = true }
  const syncOptions = (select: HTMLSelectElement, entries: Array<{ value: string; text: string }>, empty: string) => {
    const previous = select.value
    const choices = entries.length ? entries : [{ value: '', text: empty }]
    for (const option of Array.from(select.options)) {
      if (!choices.some(choice => choice.value === option.value)) option.remove()
    }
    for (const choice of choices) {
      let option = Array.from(select.options).find(item => item.value === choice.value)
      if (!option) { option = document.createElement('option'); option.value = choice.value; select.append(option) }
      if (option.textContent !== choice.text) option.textContent = choice.text
    }
    if (choices.some(choice => choice.value === previous)) select.value = previous
    return previous !== select.value
  }
  const speakersReady = () => currentSettings.rememberSpeakers && speakerState.status === 'ready'
  renderSpeakerControls = () => {
    const enabled = currentSettings.rememberSpeakers && speakerState.status !== 'disabled'
    const ready = speakersReady()
    const live = ready && sessionState === 'listening'
    const currentChanged = syncOptions(currentSpeakerEl, speakerState.speakers.map(voice => ({
      value: String(voice.speaker), text: `Speaker ${voice.speaker}${voice.name ? ` — ${voice.name}` : ''}`,
    })), 'No current voices')
    const savedChanged = syncOptions(savedSpeakerEl, speakerState.profiles.map(profile => ({ value: profile.id, text: profile.name })), 'No saved voices')
    if (currentChanged) speakerNameEdited = false
    if (savedChanged) { profileNameEdited = false; dismissForget() }
    const voice = speakerState.speakers.find(item => String(item.speaker) === currentSpeakerEl.value)
    const profile = speakerState.profiles.find(item => item.id === savedSpeakerEl.value)
    if (currentChanged || (!speakerNameEdited && document.activeElement !== speakerNameEl)) speakerNameEl.value = voice?.name ?? ''
    if (savedChanged || (!profileNameEdited && document.activeElement !== profileNameEl)) profileNameEl.value = profile?.name ?? ''
    currentSpeakerEl.disabled = !live || !voice
    speakerNameEl.disabled = !live || !voice
    enrollEl.disabled = !live || !voice || !onSpeakerEnroll
    enrollEl.textContent = voice?.name ? 'Assign another person' : 'Remember voice'
    $('#speaker-name-hint').hidden = !voice?.name
    savedSpeakerEl.disabled = !ready || !profile
    profileNameEl.disabled = !ready || !profile
    renameEl.disabled = !ready || !profile || !onSpeakerRename
    forgetEl.disabled = !ready || !profile || !onSpeakerForget
    const defaults = { loading: 'Loading saved voices…', ready: voice ? 'Matching saved voices as you speak. Captions continue while matching.' : 'Waiting for a few seconds of clear speech. Captions continue while voices are matched.',
      disabled: 'Saved voice recognition is off. Enable it in Settings.', unavailable: 'Saved voices are unavailable on this server.' }
    $('#speaker-status').textContent = !enabled ? defaults.disabled : speakerState.message || defaults[speakerState.status]
    $('#speaker-audio').textContent = !enabled ? '' : sessionState !== 'listening'
      ? 'Resume or start a session to name a current voice.'
      : voice ? `${Math.max(0, Number.isFinite(voice.seconds) ? voice.seconds : 0).toFixed(1)} seconds collected for this voice. Clear, uninterrupted speech helps recognition.`
        : 'Current voices appear as speech is recognized.'
    if (!ready || !speakerState.profiles.some(item => item.id === forgetProfileId)) dismissForget()
  }
  currentSpeakerEl.addEventListener('change', () => { speakerNameEdited = false; speakerNameEl.value = ''; setSpeakerMessage(''); renderSpeakerControls() })
  savedSpeakerEl.addEventListener('change', () => { profileNameEdited = false; profileNameEl.value = ''; dismissForget(); setSpeakerMessage(''); renderSpeakerControls() })
  speakerNameEl.addEventListener('input', () => { speakerNameEdited = true; speakerNameEl.removeAttribute('aria-invalid') })
  profileNameEl.addEventListener('input', () => { profileNameEdited = true; profileNameEl.removeAttribute('aria-invalid') })
  const readName = (input: HTMLInputElement) => {
    const name = normalizeSpeakerName(input.value)
    if (!name) {
      input.setAttribute('aria-invalid', 'true')
      input.focus()
      setSpeakerMessage('Enter a name of 1–40 letters, with spaces, apostrophes, or hyphens.')
      return ''
    }
    input.value = name
    if (input === speakerNameEl) speakerNameEdited = true
    else profileNameEdited = true
    input.removeAttribute('aria-invalid')
    setSpeakerMessage('')
    return name
  }
  enrollEl.addEventListener('click', () => {
    if (enrollEl.disabled) return
    const name = readName(speakerNameEl)
    if (name) onSpeakerEnroll?.(Number(currentSpeakerEl.value), name)
  })
  renameEl.addEventListener('click', () => {
    if (renameEl.disabled) return
    const name = readName(profileNameEl)
    if (name) onSpeakerRename?.(savedSpeakerEl.value, name)
  })
  forgetEl.addEventListener('click', () => {
    if (forgetEl.disabled) return
    forgetProfileId = savedSpeakerEl.value
    const profile = speakerState.profiles.find(item => item.id === forgetProfileId)
    $('#speaker-forget-prompt').textContent = `Forget the saved voice for ${profile?.name ?? 'this person'}? Future recognition will need a new profile.`
    forgetConfirmationEl.hidden = false
  })
  $<HTMLButtonElement>('#speaker-forget-cancel').addEventListener('click', dismissForget)
  $<HTMLButtonElement>('#speaker-forget-confirm').addEventListener('click', () => {
    if (!speakersReady() || !forgetProfileId || !speakerState.profiles.some(item => item.id === forgetProfileId)) return
    const profileId = forgetProfileId
    dismissForget()
    onSpeakerForget?.(profileId)
  })
  cueButtonEl.addEventListener('click', () => onCueAction?.())
  for (const mode of ['translate', 'conversate'] as const) {
    $<HTMLButtonElement>(`#mode-${mode}`).addEventListener('click', () => {
      if (currentSettings.appMode === mode) return
      currentSettings = { ...currentSettings, appMode: mode }
      setAppMode(mode)
      onSave({ ...currentSettings })
    })
  }
  const serverUrlEl = $<HTMLInputElement>('#serverUrl')
  const serverErrorEl = $<HTMLParagraphElement>('#server-error')
  const sourceEl = $<HTMLSelectElement>('#sourceLanguage')
  const sourceHintEl = $('#source-hint')
  const outputModeEl = $<HTMLSelectElement>('#outputMode')
  const savedEl = $('#saved')
  const detailsEl = $<HTMLDetailsElement>('#settings')
  const settingsToggle = $<HTMLButtonElement>('#settings-toggle')

  settingsToggle.addEventListener('click', () => {
    detailsEl.open = !detailsEl.open
    settingsToggle.setAttribute('aria-expanded', String(detailsEl.open))
    if (detailsEl.open) detailsEl.scrollIntoView?.({ block: 'nearest' })
  })
  detailsEl.addEventListener('toggle', () => settingsToggle.setAttribute('aria-expanded', String(detailsEl.open)))
  sourceEl.addEventListener('change', () => {
    const sourceLanguage = LANGUAGES.some(language => language.code === sourceEl.value) ? sourceEl.value : 'auto'
    currentSettings = { ...currentSettings, sourceLanguage }
    sourceHintEl.textContent = sourceHint(sourceLanguage)
    onSave({ ...currentSettings })
  })
  serverUrlEl.addEventListener('input', () => {
    serverErrorEl.hidden = true
    serverUrlEl.removeAttribute('aria-invalid')
  })
  const copyEl = $<HTMLButtonElement>('#copyTl')
  copyEl.addEventListener('click', () => {
    void copyToClipboard(((tlFinalEl.textContent ?? '') + (tlInterimEl.textContent ?? '')).trim(), copyEl)
  })
  pauseEl.addEventListener('click', () => onSessionAction(
    sessionState === 'ended' ? 'start' : sessionState === 'paused' ? 'resume' : 'pause',
  ))
  endEl.addEventListener('click', () => onSessionAction('end'))

  $<HTMLButtonElement>('#save').addEventListener('click', () => {
    let serverUrl: string
    try {
      serverUrl = validateServerUrl(serverUrlEl.value)
    } catch (error) {
      serverErrorEl.textContent = error instanceof Error ? error.message : String(error)
      serverErrorEl.hidden = false
      serverUrlEl.setAttribute('aria-invalid', 'true')
      serverUrlEl.focus()
      return
    }
    serverUrlEl.value = serverUrl
    const next: AppSettings = {
      ...currentSettings,
      serverUrl,
      aiProvider: $<HTMLSelectElement>('#aiProvider').value as AppSettings['aiProvider'],
      prepNotes: $<HTMLTextAreaElement>('#prepNotes').value.slice(0, 5000),
      cueAutoShow: $<HTMLInputElement>('#cueAutoShow').checked,
      cueDurationSeconds: Number($<HTMLSelectElement>('#cueDuration').value),
      captionHoldSeconds: Number($<HTMLSelectElement>('#captionHold').value),
      sourceLanguage: sourceEl.value,
      outputMode: outputModeEl.value === 'translation' ? 'translation' : 'transcript',
      splitSentences: $<HTMLInputElement>('#split').checked,
      speakerLabels: $<HTMLInputElement>('#speakers').checked,
      rememberSpeakers: $<HTMLInputElement>('#rememberSpeakers').checked,
      align: $<HTMLSelectElement>('#align').value === 'center' ? 'center' : 'left',
      vAlign: $<HTMLSelectElement>('#valign').value === 'top' ? 'top' : 'bottom',
      lineGap: Number($<HTMLSelectElement>('#linegap').value) || 0,
      widthPct: Number($<HTMLSelectElement>('#width').value) || 100,
      maxLines: Number($<HTMLSelectElement>('#maxlines').value) || 0,
    }
    currentSettings = next
    renderSpeakerControls()
    setOutputMode(next.outputMode)
    savedEl.textContent = 'Saved'
    setTimeout(() => (savedEl.textContent = ''), 2000)
    if (next.serverUrl) detailsEl.open = false
    onSave({ ...next })
  })

  setSessionState('listening')
  setOutputMode(settings.outputMode)
  setAppMode(settings.appMode)
  injectStyles()
}

function sourceHint(code: string) {
  return code === 'auto' ? 'Automatic language detection' : `Source language: ${langName(code)}`
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = kind === 'error' || sessionState === 'listening' ? STATUS_LABEL[kind] : sessionState === 'paused' ? 'Paused' : 'Ended'
  statusMessageEl.textContent = text
  statusMessageEl.hidden = !text
}

export function setTranslation(finalText: string, interimText: string) {
  if (!tlFinalEl) return
  const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80
  const fragment = document.createDocumentFragment()
  finalText.split('\n').forEach((line, index) => {
    if (index) fragment.appendChild(document.createTextNode('\n'))
    const row = document.createElement('p')
    row.className = 'transcript-line'
    const speaker = line.match(/^((?:Speaker (?:\d+|pending)|[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,39}):)(.*)$/u)
    if (speaker) {
      const label = document.createElement('span')
      label.className = 'speaker-label'
      label.textContent = speaker[1]
      row.append(label, document.createTextNode(speaker[2]))
    } else row.textContent = line
    fragment.appendChild(row)
  })
  tlFinalEl.replaceChildren(fragment)
  tlInterimEl.textContent = interimText
  emptyEl.hidden = Boolean(finalText.trim() || interimText.trim())
  if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight
}

export function setOutputMode(mode: OutputMode) {
  currentOutputMode = mode
  if (tlLabelEl) tlLabelEl.textContent = mode === 'translation' ? 'Translation · English' : 'Transcript'
}

export function setAppMode(mode: 'translate' | 'conversate') {
  appMode = mode
  const title = document.querySelector('h1')
  if (title) title.textContent = mode === 'conversate' ? 'Conversate' : 'Translate'
  for (const name of ['translate', 'conversate']) {
    document.querySelector(`#mode-${name}`)?.setAttribute('aria-pressed', String(name === mode))
  }
  document.querySelector('.language-pair')?.classList.toggle('source-only', mode === 'conversate')
  const sourceLabel = document.querySelector('#source-label')
  if (sourceLabel) sourceLabel.textContent = mode === 'conversate' ? 'Speech language' : 'From'
  const outputField = document.querySelector<HTMLElement>('#output-mode-field')
  if (outputField) outputField.hidden = mode === 'conversate'
  if (conversationPanelEl) conversationPanelEl.hidden = mode !== 'conversate'
  if (conversationSettingsEl) conversationSettingsEl.hidden = mode !== 'conversate'
  if (summaryEl) summaryEl.hidden = mode !== 'conversate' || !hasSummary
  setOutputMode(currentOutputMode)
}

export function setConversationCue(cue: { kind: string; text: string } | null) {
  if (!cueTextEl) return
  cueKindEl.textContent = cue?.kind ?? ''
  cueKindEl.hidden = !cue
  cueTextEl.textContent = cue?.text ?? 'Cues will appear here during your conversation.'
  cueButtonEl.disabled = !cue || !canShowCue
}

export function setConversationStatus(text: string) {
  if (conversationStatusEl) conversationStatusEl.textContent = text
}

export function setConversationSummary(summary: string, actionItems: string[]) {
  if (!summaryEl) return
  summaryTextEl.textContent = summary
  actionItemsEl.replaceChildren(...actionItems.map(text => {
    const item = document.createElement('li')
    item.textContent = text
    return item
  }))
  const actionsTitle = document.querySelector<HTMLElement>('#action-items-title')
  if (actionsTitle) actionsTitle.hidden = actionItems.length === 0
  hasSummary = Boolean(summary || actionItems.length)
  summaryEl.hidden = appMode !== 'conversate' || !hasSummary
}

export function setSessionState(state: SessionState) {
  sessionState = state
  renderSpeakerControls()
  if (!pauseEl) return
  if (state !== 'listening') {
    statusEl.className = 'status'
    statusEl.textContent = state === 'paused' ? 'Paused' : 'Ended'
  }
  pauseEl.innerHTML = `${state === 'listening' ? icons.pause : icons.play}<span>${state === 'listening' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start'}</span>`
  pauseEl.classList.toggle('session-primary', state === 'ended')
  endEl.disabled = state === 'ended'
  const heading = emptyEl.querySelector('p')
  const description = emptyEl.querySelector('span')
  if (heading) heading.textContent = state === 'listening' ? 'Listening…' : state === 'paused' ? 'Translation paused' : 'Session ended'
  if (description) description.textContent = state === 'listening' ? 'Speak naturally. Translation appears here.' : state === 'paused' ? 'Resume when you are ready.' : 'Start a new session when you are ready.'
}

export function setSpeakerState(state: SpeakerState) {
  speakerState = state
  renderSpeakerControls()
}

export function setSpeakerMessage(text: string) {
  const message = document.querySelector<HTMLElement>('#speaker-message')
  if (!message) return
  message.textContent = text
  message.hidden = !text
}

async function copyToClipboard(text: string, button: HTMLButtonElement) {
  const flash = (message: string) => {
    const previous = button.textContent
    button.textContent = message
    setTimeout(() => (button.textContent = previous), 1500)
  }
  if (!text) return flash('Nothing yet')
  try {
    await navigator.clipboard.writeText(text)
    flash('Copied')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try { flash(document.execCommand('copy') ? 'Copied' : 'Copy failed') }
    catch { flash('Copy failed') }
    finally { area.remove() }
  }
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function injectStyles() {
  const existing = document.querySelector('#translate-styles')
  if (existing) return
  const style = document.createElement('style')
  style.id = 'translate-styles'
  style.textContent = `
    :root { color-scheme: light; --color-bg: #EEEEEE; --color-surface: #FFFFFF;
      --color-text: #232323; --color-dim: #7B7B7B; --color-line: #E5E5E5;
      --color-accent: #FEF991; --color-input: rgba(35,35,35,.06); --color-error: #A52A2A;
      --font-body: 'FK Grotesk Neue', 'Source Han Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; overflow-x: clip; background: var(--color-bg); color: var(--color-text);
      font: 16px/1.4 var(--font-body); -webkit-text-size-adjust: 100%; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button, summary, select { -webkit-tap-highlight-color: transparent; }
    button { cursor: pointer; white-space: nowrap; }
    button:disabled { cursor: default; opacity: .35; }
    button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible {
      outline: 2px solid var(--color-text); outline-offset: 3px; }
    button:active:not(:disabled) { transform: translateY(1px); }
    [hidden] { display: none !important; }
    .panel { max-width: 640px; margin: 0 auto; padding: 12px 12px 88px; min-height: 100vh;
      min-height: 100svh; display: flex; flex-direction: column; gap: 10px; }
    .topbar { display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; align-items: center; min-height: 48px; }
    h1 { margin: 0; text-align: center; font-size: 18px; font-weight: 500; letter-spacing: -.02em; }
    svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.3;
      stroke-linecap: square; stroke-linejoin: miter; flex: 0 0 auto; }
    .app-mark { display: flex; align-items: center; justify-content: center; }
    .icon-button { border: 0; background: transparent; display: grid; place-items: center; width: 40px; height: 40px; }
    .icon-button:hover { background: var(--color-input); }
    .mode-tabs { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 4px; }
    .mode-tabs button { min-height: 38px; border: 0; border-radius: 5px; background: var(--color-surface); font-size: 13px; }
    .mode-tabs button[aria-pressed="true"] { background: var(--color-text); color: var(--color-surface); }
    .conversation-panel { background: var(--color-surface); border-radius: 6px; padding: 16px; }
    h2, h3 { font-weight: 500; letter-spacing: -.01em; margin: 0 0 10px; font-size: 16px; }
    h3 { font-size: 13px; margin-top: 18px; }
    .conversation-panel .hint { margin-top: 4px; }
    .cue-kind { font-size: 11px; color: var(--color-dim); margin-top: 16px; text-transform: uppercase; letter-spacing: .04em; }
    .cue-text, .summary-text { font-size: 15px; line-height: 1.45; margin: 10px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    #action-items { margin: 0; padding-left: 20px; font-size: 14px; }
    #action-items li + li { margin-top: 8px; }
    .optional { font-weight: 400; padding-left: 8px; }
    .field textarea { resize: vertical; min-height: 100px; }
    .language-pair { display: grid; grid-template-columns: minmax(0, 1fr) 32px minmax(0, 1fr);
      align-items: center; background: var(--color-surface); border-radius: 6px; padding: 12px 20px; min-height: 84px; }
    .language-pair.source-only { grid-template-columns: minmax(0, 1fr); }
    .source-only .language-arrow, .source-only .language-target { display: none; }
    .language-side { min-width: 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .language-side label, .language-caption { font-size: 11px; color: var(--color-dim); }
    .language-side select { font-size: 22px; letter-spacing: -.02em; width: 100%; max-width: 210px;
      border: 0; background: transparent; text-align: center; padding: 2px; cursor: pointer; text-overflow: ellipsis; }
    .language-target #target-language { font-size: 22px; letter-spacing: -.02em; }
    .language-arrow { display: grid; place-items: center; color: var(--color-dim); }
    .source-hint { margin: 0 4px 2px; font-size: 12px; color: var(--color-dim); }
    .settings { background: var(--color-surface); border-radius: 6px; padding: 16px; }
    .settings:not([open]) { display: none; }
    .settings summary { font-size: 16px; font-weight: 500; cursor: pointer; }
    .group-title { margin: 20px 0 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--color-dim); }
    .field { min-width: 0; display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
    .field label { font-size: 13px; color: var(--color-dim); }
    .field input, .field select, .field textarea { width: 100%; border: 1px solid var(--color-line); background: var(--color-input);
      border-radius: 5px; min-height: 44px; padding: 10px; }
    .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
    .hint, .field-error { margin: 0; font-size: 12px; color: var(--color-dim); overflow-wrap: anywhere; }
    .field-error { color: var(--color-error); }
    .check { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-size: 14px; }
    .check input { width: 18px; height: 18px; accent-color: var(--color-text); }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
    .primary { background: var(--color-accent); border: 0; border-radius: 4px; padding: 10px 24px; min-height: 44px; }
    .primary:hover { filter: brightness(.97); }
    .secondary { background: var(--color-input); border: 0; border-radius: 4px; padding: 10px 16px; min-height: 44px; }
    .speaker-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .speaker-status { margin: 10px 0 14px !important; }
    .forget-confirmation { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--color-line); }
    .forget-confirmation .speaker-actions { margin-top: 10px; }
    .saved { font-size: 13px; color: var(--color-dim); }
    .pane { flex: 1; min-height: 320px; background: var(--color-surface); border-radius: 6px; padding: 16px;
      display: flex; flex-direction: column; }
    .pane-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .pane-label { font-size: 12px; color: var(--color-dim); min-width: 0; }
    .pane-tools { display: flex; align-items: center; gap: 12px; }
    .status { font-size: 11px; white-space: nowrap; color: var(--color-dim); }
    .status::before { content: '●'; margin-right: 5px; font-size: 7px; vertical-align: 1px; }
    .status-listening { color: var(--color-text); }
    .status-listening::before { color: var(--color-text); }
    .status-error { color: var(--color-error); }
    .text-button { background: transparent; border: 0; font-size: 12px; color: var(--color-dim); padding: 8px 0 8px 8px; }
    .text-button:hover { color: var(--color-text); }
    .status-message { margin: 6px 0 12px; color: var(--color-dim); font-size: 12px; overflow-wrap: anywhere; }
    .pane-body { flex: 1; min-height: 220px; max-height: 65vh; overflow-y: auto; overflow-wrap: anywhere;
      white-space: normal; font-size: 16px; line-height: 1.45; letter-spacing: -.01em; }
    .transcript-final { display: contents; }
    .transcript-line { white-space: pre-wrap; margin: 0; padding: 14px 0; border-bottom: 1px solid var(--color-line); }
    .transcript-line:empty { display: none; }
    .speaker-label { display: block; font-size: 11px; color: var(--color-dim); padding-bottom: 5px; }
    .interim { white-space: pre-wrap; color: var(--color-dim); padding-top: 14px; }
    .interim:empty { padding: 0; }
    .empty-transcript { padding: 48px 4px; text-align: center; color: var(--color-dim); }
    .empty-transcript p { color: var(--color-text); font-size: 18px; margin: 0 0 8px; }
    .empty-transcript span { font-size: 13px; }
    .session-bar { position: fixed; z-index: 2; bottom: 0; left: 50%; transform: translateX(-50%);
      width: 100%; max-width: 640px; padding: 10px 12px max(12px, env(safe-area-inset-bottom));
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; background: var(--color-bg); }
    .session-button { min-height: 48px; background: var(--color-surface); border: 0; border-radius: 5px;
      display: flex; align-items: center; justify-content: center; gap: 14px; }
    .session-button:hover:not(:disabled) { background: var(--color-accent); }
    .session-button.session-primary { background: var(--color-accent); }
    @media (min-width: 768px) { .panel { padding-top: 20px; } }
    @media (max-width: 350px) { .language-pair { padding-left: 10px; padding-right: 10px; }
      .language-side select, .language-target #target-language { font-size: 20px; }
      .pane { padding: 12px; } .pane-tools { gap: 6px; } }
  `
  document.head.appendChild(style)
}
