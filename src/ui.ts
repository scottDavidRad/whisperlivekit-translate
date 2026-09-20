import { validateServerUrl, type AppSettings, type OutputMode } from './settings'

type Status = 'connecting' | 'listening' | 'error' | 'setup' | 'reconnecting'

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting',
  listening: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Error',
  setup: 'Setup',
}

let statusEl: HTMLDivElement
let statusMessageEl: HTMLParagraphElement
let tlFinalEl: HTMLSpanElement
let tlInterimEl: HTMLSpanElement
let tlLabelEl: HTMLDivElement

export interface UiHandlers {
  settings: AppSettings
  onSave: (next: AppSettings) => void
}

export function mountUi({ settings, onSave }: UiHandlers) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const opt = (n: number, label: string, sel: number) =>
    `<option value="${n}"${n === sel ? ' selected' : ''}>${label}</option>`

  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>WhisperLiveKit Translate</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>
      <p id="status-message" class="status-message" role="status" aria-live="polite">Connecting…</p>

      <details id="settings" class="settings"${settings.serverUrl ? '' : ' open'}>
        <summary>Settings</summary>

        <div class="group-title">WhisperLiveKit server</div>
        <div class="field">
          <label for="serverUrl">Server WebSocket URL</label>
          <input id="serverUrl" type="url" autocomplete="off" autocapitalize="off"
            spellcheck="false" placeholder="ws://&lt;computer LAN IP&gt;:8000/asr"
            value="${escapeAttr(settings.serverUrl)}" aria-describedby="server-hint server-error" />
          <p id="server-hint" class="hint">Run WhisperLiveKit on your computer. Use its LAN address from your phone;
            localhost points to the phone itself. HTTPS pages require wss://.</p>
          <p id="server-error" class="field-error" role="alert" hidden></p>
        </div>
        <div class="field">
          <label for="outputMode">Display output</label>
          <select id="outputMode">
            <option value="transcript"${settings.outputMode === 'transcript' ? ' selected' : ''}>Transcript</option>
            <option value="translation"${settings.outputMode === 'translation' ? ' selected' : ''}>Translation</option>
          </select>
          <p class="hint">The server controls the model, source language, and diarization.
            English translation requires starting the server with <code>--direct-english-translation</code>.
            Selecting Translation here labels that server output; it does not change the server mode.</p>
        </div>

        <div class="group-title">Glasses display</div>
        <div class="row">
          <div class="field">
            <label for="align">Alignment</label>
            <select id="align">
              <option value="left"${settings.align === 'left' ? ' selected' : ''}>Left</option>
              <option value="center"${settings.align === 'center' ? ' selected' : ''}>Center</option>
            </select>
          </div>
          <div class="field">
            <label for="valign">Anchor</label>
            <select id="valign">
              <option value="bottom"${settings.vAlign === 'bottom' ? ' selected' : ''}>Bottom</option>
              <option value="top"${settings.vAlign === 'top' ? ' selected' : ''}>Top</option>
            </select>
          </div>
          <div class="field">
            <label for="linegap">Line spacing</label>
            <select id="linegap">${opt(0, 'Normal', settings.lineGap)}${opt(1, 'Relaxed', settings.lineGap)}${opt(2, 'Loose', settings.lineGap)}</select>
          </div>
          <div class="field">
            <label for="width">Text width</label>
            <select id="width">${opt(100, 'Full', settings.widthPct)}${opt(85, 'Wide', settings.widthPct)}${opt(70, 'Medium', settings.widthPct)}${opt(55, 'Narrow', settings.widthPct)}</select>
          </div>
          <div class="field">
            <label for="maxlines">Max lines</label>
            <select id="maxlines">${[0, 1, 2, 3, 4, 5, 6, 8].map(n => opt(n, n === 0 ? 'Auto' : String(n), settings.maxLines)).join('')}</select>
          </div>
        </div>
        <label class="check"><input id="split" type="checkbox"${settings.splitSentences ? ' checked' : ''}/> Split sentences onto new lines</label>
        <label class="check"><input id="speakers" type="checkbox"${settings.speakerLabels ? ' checked' : ''}/> Label speakers <span class="dim">(requires server diarization)</span></label>

        <div class="actions">
          <button id="save" type="button" class="primary">Save</button>
          <span id="saved" class="saved"></span>
        </div>
      </details>

      <section class="pane pane-translation pane-primary" aria-live="polite">
        <div class="pane-head">
          <div id="tl-label" class="pane-label">${settings.outputMode === 'translation' ? 'Translation · English' : 'Transcript'}</div>
          <button id="copyTl" type="button" class="ghost">Copy</button>
        </div>
        <div class="pane-body"><span id="tl-final"></span><span id="tl-interim" class="interim"></span></div>
      </section>
      <footer>Double-tap the glasses temple to exit.</footer>
    </main>
  `

  statusEl = app.querySelector<HTMLDivElement>('#status')!
  statusMessageEl = app.querySelector<HTMLParagraphElement>('#status-message')!
  tlFinalEl = app.querySelector<HTMLSpanElement>('#tl-final')!
  tlInterimEl = app.querySelector<HTMLSpanElement>('#tl-interim')!
  tlLabelEl = app.querySelector<HTMLDivElement>('#tl-label')!

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!
  const serverUrlEl = $<HTMLInputElement>('#serverUrl')
  const serverErrorEl = $<HTMLParagraphElement>('#server-error')
  const outputModeEl = $<HTMLSelectElement>('#outputMode')
  const alignEl = $<HTMLSelectElement>('#align')
  const valignEl = $<HTMLSelectElement>('#valign')
  const linegapEl = $<HTMLSelectElement>('#linegap')
  const widthEl = $<HTMLSelectElement>('#width')
  const maxlinesEl = $<HTMLSelectElement>('#maxlines')
  const splitEl = $<HTMLInputElement>('#split')
  const speakersEl = $<HTMLInputElement>('#speakers')
  const savedEl = $<HTMLSpanElement>('#saved')
  const detailsEl = $<HTMLDetailsElement>('#settings')

  serverUrlEl.addEventListener('input', () => {
    serverErrorEl.hidden = true
    serverUrlEl.removeAttribute('aria-invalid')
  })

  // Copy the currently displayed main output.
  const copyEl = $<HTMLButtonElement>('#copyTl')
  copyEl.addEventListener('click', () => {
    const text = (tlFinalEl.textContent ?? '') + (tlInterimEl.textContent ?? '')
    copyToClipboard(text.trim(), copyEl)
  })

  $<HTMLButtonElement>('#save').addEventListener('click', () => {
    let serverUrl: string
    try {
      serverUrl = validateServerUrl(serverUrlEl.value)
    } catch (err) {
      serverErrorEl.textContent = err instanceof Error ? err.message : String(err)
      serverErrorEl.hidden = false
      serverUrlEl.setAttribute('aria-invalid', 'true')
      serverUrlEl.focus()
      return
    }
    serverUrlEl.value = serverUrl
    const next: AppSettings = {
      serverUrl,
      outputMode: outputModeEl.value === 'translation' ? 'translation' : 'transcript',
      splitSentences: splitEl.checked,
      speakerLabels: speakersEl.checked,
      align: alignEl.value === 'center' ? 'center' : 'left',
      vAlign: valignEl.value === 'top' ? 'top' : 'bottom',
      lineGap: parseInt(linegapEl.value, 10) || 0,
      widthPct: parseInt(widthEl.value, 10) || 100,
      maxLines: parseInt(maxlinesEl.value, 10) || 0,
    }
    setOutputMode(next.outputMode)
    savedEl.textContent = 'Saved ✓'
    setTimeout(() => (savedEl.textContent = ''), 2000)
    if (next.serverUrl) detailsEl.open = false
    onSave(next)
  })

  setOutputMode(settings.outputMode)
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = STATUS_LABEL[kind]
  statusEl.title = text
  statusMessageEl.textContent = text
  statusMessageEl.hidden = !text
}

export function setTranslation(finalText: string, interimText: string) {
  if (!tlFinalEl) return
  tlFinalEl.textContent = finalText
  tlInterimEl.textContent = interimText
}

export function setOutputMode(mode: OutputMode) {
  if (tlLabelEl) tlLabelEl.textContent = mode === 'translation' ? 'Translation · English' : 'Transcript'
}

async function copyToClipboard(text: string, btn: HTMLButtonElement) {
  const flash = (msg: string) => {
    const prev = btn.textContent
    btn.textContent = msg
    setTimeout(() => (btn.textContent = prev), 1500)
  }
  if (!text) return flash('Nothing yet')
  try {
    await navigator.clipboard.writeText(text)
    return flash('Copied ✓')
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return flash('Copied ✓')
    } catch {
      return flash('Copy failed')
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; background: #1c1c1c; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      -webkit-text-size-adjust: 100%; }
    /* min-height (not height) so the page grows with the open settings form and
       the body scrolls — otherwise the Save button is unreachable. */
    #app { min-height: 100vh; }
    .panel { display: flex; flex-direction: column; gap: 12px; min-height: 100vh;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 20px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .status-message { margin: 0; font-size: 13px; color: #A7A7A7; overflow-wrap: anywhere; }
    .field-error { margin: 0; font-size: 13px; color: #FF453A; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px; white-space: nowrap;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status::before { content: '●'; margin-right: 5px; font-size: 9px; vertical-align: 1px; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening  { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-reconnecting { color: #FEB340; border-color: #FEB340; background: rgba(254,179,64,0.10); }
    .status-setup      { color: #FEF991; border-color: #FEF991; background: rgba(254,249,145,0.08); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }

    .settings { background: #2A2A2A; border: 1px solid #3A3A3A; border-radius: 14px; padding: 14px 16px; }
    .settings summary { cursor: pointer; font-size: 13px; letter-spacing: 0.04em;
      text-transform: uppercase; color: #A7A7A7; user-select: none; }
    .settings[open] summary { margin-bottom: 14px; }
    .group-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6E6E6E;
      margin: 6px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #343434; }
    .group-title + * { margin-top: 0; }
    .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    .field label { font-size: 12px; color: #A7A7A7; }
    .field input, .field select { background: rgba(255,255,255,0.06); color: #E5E5E5;
      border: 1px solid #3E3E3E; border-radius: 9px; padding: 11px 12px; font-size: 16px; width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    .row .field { flex: 1 1 140px; min-width: 0; margin-bottom: 0; }
    .hint { margin: 0; font-size: 12px; color: #7B7B7B; }
    .hint a { color: #FEF991; }
    .dim { color: #7B7B7B; }
    .check { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #C9C9C9; margin-bottom: 10px; }
    .check input { width: 18px; height: 18px; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
    .primary { background: #FEF991; color: #232323; border: 0; border-radius: 9px;
      padding: 11px 20px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .ghost { background: transparent; color: #A7A7A7; border: 1px solid #3E3E3E; border-radius: 8px;
      padding: 8px 12px; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .ghost:active { background: rgba(255,255,255,0.06); }
    .saved { font-size: 13px; color: #3CFA44; }

    .pane { flex: 1; display: flex; flex-direction: column; gap: 8px;
      background: #2A2A2A; border: 1px solid #3A3A3A; border-radius: 14px;
      padding: 14px 18px; min-height: 110px; }
    .pane-translation { border-color: rgba(60,250,68,0.22); }
    .pane-primary { flex: 2.5; }
    .pane-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .pane-label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #7B7B7B; }
    .pane-translation .pane-label { color: #3CFA44; }
    .pane-body { flex: 1; overflow: auto; color: #E5E5E5;
      font-size: 18px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .interim { color: #8E8E8E; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
