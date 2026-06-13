import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { startSttStream, type SttClient } from './asr/stt'
import { mountUi, setStatus, setTranscript, setTranslation, setTargetLangLabel } from './ui'
import { type AppSettings, SETTINGS_KEY, mergeSettings } from './settings'

const bridge = await waitForEvenAppBridge()

// ── Serial bridge queue ──────────────────────────────────────────────────────
// The SDK can crash the BLE link if bridge calls overlap, and a flaky hop can
// hang ~30s. Funnel every mutation through one FIFO chain with a per-call
// timeout so calls never overlap and never hang the pipeline.
let bridgeChain: Promise<unknown> = Promise.resolve()
function serial<T>(label: string, fn: () => Promise<T>, ms = 4000): Promise<T> {
  const run = bridgeChain.then(() =>
    Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error(`bridge.${label} timed out (${ms}ms)`)), ms),
      ),
    ]),
  )
  bridgeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ── Settings (per-user, persisted via the SDK) ───────────────────────────────
async function loadSettings(): Promise<AppSettings> {
  let raw = ''
  try {
    raw = await bridge.getLocalStorage(SETTINGS_KEY)
  } catch {
    /* first run */
  }
  const s = mergeSettings(raw)
  if (!s.apiKey && import.meta.env.DEV) {
    const devKey = (import.meta.env.VITE_STT_API_KEY as string) || ''
    if (devKey) s.apiKey = devKey
  }
  return s
}

let settings = await loadSettings()
mountUi({ settings, onSave: handleSave })

// ── Render state ─────────────────────────────────────────────────────────────
let curTranscript = 'Starting…'
let curTranslation = '…'
let lastTranscript = ''
let lastTranslation = ''
let rawTx = ''
let rawTl = ''

// ── Layout / geometry (borderless; width-aware; split or full-screen) ────────
const PAD = 3
const LINE_H = 27
const spaceW = Math.max(1, getTextWidth('a a') - getTextWidth('aa'))

let hasTranscript = settings.showTranscript
let transcriptLines = 0
let translationLines = 0
let paneW = 576
let paneX = 0
let innerW = 570

function mkPane(id: number, name: string, y: number, h: number, capture: boolean, content: string) {
  return new TextContainerProperty({
    xPosition: paneX, yPosition: y, width: paneW, height: h,
    borderWidth: 0, paddingLength: PAD,
    containerID: id, containerName: name, content, isEventCapture: capture ? 1 : 0,
  })
}

function buildLayout() {
  hasTranscript = settings.showTranscript
  paneW = Math.round((576 * (settings.widthPct || 100)) / 100)
  paneX = Math.round((576 - paneW) / 2)
  innerW = paneW - 2 * PAD
  if (hasTranscript) {
    const TOP_H = 62
    const BOT_H = 288 - TOP_H
    transcriptLines = Math.floor((TOP_H - 2 * PAD) / LINE_H)
    translationLines = Math.floor((BOT_H - 2 * PAD) / LINE_H)
    return {
      containerTotalNum: 2,
      textObject: [
        mkPane(1, 'transcript', 0, TOP_H, false, curTranscript),
        mkPane(2, 'translation', TOP_H, BOT_H, true, curTranslation),
      ],
    }
  }
  transcriptLines = 0
  translationLines = Math.floor((288 - 2 * PAD) / LINE_H)
  return { containerTotalNum: 1, textObject: [mkPane(2, 'translation', 0, 288, true, curTranslation)] }
}

const created = await serial('createStartUpPage', () =>
  bridge.createStartUpPageContainer(new CreateStartUpPageContainer(buildLayout())),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

async function applyLayout() {
  await serial('rebuild', () => bridge.rebuildPageContainer(new RebuildPageContainer(buildLayout())))
}

// ── Text fitting: wrap, align, sentence-spacing, keep last N (autoscroll) ────
function wrapToLines(text: string, maxW: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (word === '') continue
      const cand = line ? line + ' ' + word : word
      if (getTextWidth(cand) <= maxW) {
        line = cand
      } else {
        if (line) lines.push(line)
        if (getTextWidth(word) > maxW) {
          let chunk = ''
          for (const ch of word) {
            if (getTextWidth(chunk + ch) <= maxW) chunk += ch
            else {
              if (chunk) lines.push(chunk)
              chunk = ch
            }
          }
          line = chunk
        } else {
          line = word
        }
      }
    }
    lines.push(line)
  }
  return lines
}

function splitSentences(text: string): string {
  return text
    .replace(/([.!?。！？])[ \t]+/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
}

function centerLine(line: string): string {
  const w = getTextWidth(line)
  if (w >= innerW) return line
  const pad = Math.floor((innerW - w) / 2 / spaceW)
  return pad > 0 ? ' '.repeat(pad) + line : line
}

// `visibleLines` = how many content lines to show (most recent).
// `paneLines`    = physical rows in the pane; for bottom anchoring we pad the
//                  top so the newest line sits at the pane's bottom row.
function fitTail(text: string, placeholder: string, visibleLines: number, paneLines: number): string {
  let t = text.trim()
  let lines: string[]
  if (!t) {
    lines = [placeholder]
  } else {
    if (settings.splitSentences) t = splitSentences(t)
    const tail = t.length > 1400 ? t.slice(-1400) : t
    const gap = settings.lineGap || 0
    const out: string[] = []
    const paras = tail.split('\n')
    for (let i = 0; i < paras.length; i++) {
      if (i > 0) for (let g = 0; g < gap; g++) out.push('')
      let wl = wrapToLines(paras[i], innerW)
      if (settings.align === 'center') wl = wl.map(centerLine)
      out.push(...wl)
    }
    lines = out.slice(-visibleLines)
    while (lines.length && lines[0] === '') lines.shift() // no leading blank
  }
  if (settings.vAlign === 'bottom') {
    // Pad with single-space rows (guaranteed to render) so content sticks to
    // the bottom — the newest line stays at a fixed position.
    const pad = Math.max(0, paneLines - lines.length)
    if (pad > 0) lines = new Array(pad).fill(' ').concat(lines)
  }
  return lines.join('\n')
}

function recomputeDisplay() {
  if (hasTranscript) curTranscript = fitTail(rawTx, 'Listening…', transcriptLines, transcriptLines)
  const visible = settings.maxLines > 0 ? Math.min(translationLines, settings.maxLines) : translationLines
  const primary = settings.targetLang ? rawTl : rawTx
  curTranslation = fitTail(primary, settings.targetLang ? 'Translation…' : 'Listening…', visible, translationLines)
}

// ── Glasses render (debounced + coalesced; never overlapping) ────────────────
let renderTimer: number | null = null
let renderDirty = false
let renderInFlight = false

function scheduleGlassesRender() {
  renderDirty = true
  if (renderInFlight || renderTimer !== null) return
  renderTimer = window.setTimeout(runRender, 120)
}

async function runRender() {
  renderTimer = null
  if (renderInFlight) return
  renderInFlight = true
  try {
    while (renderDirty) {
      renderDirty = false
      const tx = curTranscript
      const tl = curTranslation
      if (hasTranscript && tx !== lastTranscript) {
        await serial('upgrade.transcript', () =>
          bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'transcript', content: tx })),
        )
        lastTranscript = tx
      }
      if (tl !== lastTranslation) {
        await serial('upgrade.translation', () =>
          bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'translation', content: tl })),
        )
        lastTranslation = tl
      }
    }
  } catch (err) {
    // Leave last* unset on the failed pane so the next change retries it.
    console.warn('[render] upgrade failed:', (err as Error)?.message ?? err)
  } finally {
    renderInFlight = false
    if (renderDirty) scheduleGlassesRender()
  }
}

function forceRender() {
  lastTranscript = ''
  lastTranslation = ''
  scheduleGlassesRender()
}

// ── STT lifecycle ────────────────────────────────────────────────────────────
let stt: SttClient | null = null
let micOn = false

function onSnapshot({ transcriptFinal, transcriptInterim, translationFinal, translationInterim }: {
  transcriptFinal: string; transcriptInterim: string; translationFinal: string; translationInterim: string
}) {
  rawTx = transcriptFinal + transcriptInterim
  rawTl = translationFinal + translationInterim
  recomputeDisplay()
  setTranscript(transcriptFinal, transcriptInterim)
  setTranslation(translationFinal, translationInterim)
  scheduleGlassesRender()
}

function onSttError(err: unknown) {
  setStatus('error', `STT: ${(err as Error)?.message ?? err}`)
  console.error('STT error:', err)
}

function applySettings() {
  stt?.close()
  stt = null
  setTargetLangLabel(settings.targetLang)

  if (!settings.apiKey) {
    if (micOn) {
      serial('audioOff', () => bridge.audioControl(false))
      micOn = false
    }
    curTranscript = '⚙ Setup needed'
    curTranslation = 'Open this app on your phone → Settings, and add your Soniox API key.'
    forceRender()
    setStatus('setup', 'Add your Soniox API key in Settings')
    return
  }

  try {
    stt = startSttStream(
      {
        apiKey: settings.apiKey,
        targetLang: settings.targetLang,
        splitSentences: settings.splitSentences,
        speakerLabels: settings.speakerLabels,
        noTranslateLangs: settings.noTranslateLangs,
      },
      onSnapshot,
      onSttError,
      status => {
        if (status === 'live') setStatus('listening', 'Microphone live · double-tap the temple to exit')
        else if (status === 'connecting') setStatus('connecting', 'Connecting to Soniox…')
        else if (status === 'reconnecting') setStatus('reconnecting', 'Reconnecting…')
      },
    )
  } catch (err) {
    onSttError(err)
    return
  }

  if (!micOn) {
    serial('audioOn', () => bridge.audioControl(true))
    micOn = true
  }
}

async function handleSave(next: AppSettings) {
  const prev = settings
  settings = next
  serial('saveSettings', () => bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(next))).catch(err =>
    console.error('Failed to persist settings:', err),
  )

  const needRebuild = next.showTranscript !== prev.showTranscript || next.widthPct !== prev.widthPct
  const needRestart =
    next.apiKey !== prev.apiKey ||
    next.targetLang !== prev.targetLang ||
    next.splitSentences !== prev.splitSentences ||
    next.speakerLabels !== prev.speakerLabels ||
    next.noTranslateLangs.join(',') !== prev.noTranslateLangs.join(',')

  if (needRestart) {
    rawTx = ''
    rawTl = ''
    curTranscript = 'Listening…'
    curTranslation = next.targetLang ? 'Translation…' : 'Listening…'
    if (needRebuild) await applyLayout()
    else forceRender()
    applySettings()
  } else {
    if (needRebuild) await applyLayout()
    recomputeDisplay()
    forceRender()
  }
}

applySettings()

// ── Cleanup + event routing ──────────────────────────────────────────────────
let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  serial('audioOff', () => bridge.audioControl(false))
  stt?.close()
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    serial('exit', () => bridge.shutDownPageContainer(1))
    return
  }

  // Lifecycle — survive the 5-minute locked-phone test cleanly.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    if (micOn) {
      serial('audioOff', () => bridge.audioControl(false))
      micOn = false
    }
    stt?.close()
    stt = null
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    forceRender()
    applySettings()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
