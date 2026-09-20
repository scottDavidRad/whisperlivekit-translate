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
import { mountUi, setStatus, setTranslation, setOutputMode } from './ui'
import { type AppSettings, SETTINGS_KEY, mergeSettings } from './settings'

const bridge = await waitForEvenAppBridge()

// ── Serial bridge queue ──────────────────────────────────────────────────────
// The SDK can crash the BLE link if bridge calls overlap, and a flaky hop can
// hang ~30s. Funnel every mutation through one FIFO chain with a per-call
// timeout so an unresponsive call does not hang the pipeline.
let bridgeChain: Promise<unknown> = Promise.resolve()
function serial<T>(label: string, fn: () => Promise<T>, ms = 4000): Promise<T> {
  const run = bridgeChain.then(async () => {
    let timer: number | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`bridge.${label} timed out (${ms}ms)`)), ms)
        }),
      ])
    } finally {
      window.clearTimeout(timer)
    }
  })
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
  if (!s.serverUrl) s.serverUrl = import.meta.env.VITE_WHISPERLIVEKIT_URL || ''
  return s
}

let settings = await loadSettings()
let startupReady = false
let foreground = true
let cleanedUp = false

// ── Render state ─────────────────────────────────────────────────────────────
let currentText = 'Starting…'
let lastText = ''
let rawText = ''

// ── Layout / geometry (one borderless, width-aware pane) ──────────────────────
const PAD = 3
const LINE_H = 27
const spaceW = Math.max(1, getTextWidth('a a') - getTextWidth('aa'))

const paneLines = Math.floor((288 - 2 * PAD) / LINE_H)
let paneW = 576
let paneX = 0
let innerW = 570

function buildLayout() {
  paneW = Math.round((576 * (settings.widthPct || 100)) / 100)
  paneX = Math.round((576 - paneW) / 2)
  innerW = paneW - 2 * PAD
  return {
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      xPosition: paneX, yPosition: 0, width: paneW, height: 288,
      borderWidth: 0, paddingLength: PAD,
      containerID: 1, containerName: 'output', content: currentText, isEventCapture: 1,
    })],
  }
}

async function applyLayout() {
  if (!startupReady || cleanedUp) return
  const rebuilt = await serial('rebuild', () => bridge.rebuildPageContainer(new RebuildPageContainer(buildLayout())))
  if (!rebuilt) throw new Error('The glasses display could not be rebuilt.')
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
  const visible = settings.maxLines > 0 ? Math.min(paneLines, settings.maxLines) : paneLines
  currentText = fitTail(rawText, settings.outputMode === 'translation' ? 'Translation…' : 'Listening…', visible, paneLines)
}

// ── Glasses render (debounced + coalesced; never overlapping) ────────────────
let renderTimer: number | null = null
let renderDirty = false
let renderInFlight = false

function scheduleGlassesRender() {
  if (!startupReady || cleanedUp || !foreground) return
  renderDirty = true
  if (renderInFlight || renderTimer !== null) return
  renderTimer = window.setTimeout(runRender, 120)
}

async function runRender() {
  renderTimer = null
  if (renderInFlight || cleanedUp || !foreground) return
  renderInFlight = true
  try {
    while (renderDirty && !cleanedUp && foreground) {
      renderDirty = false
      const text = currentText
      if (text !== lastText) {
        const upgraded = await serial('upgrade.output', () =>
          bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'output', content: text })),
        )
        if (!upgraded) throw new Error('The glasses text could not be updated.')
        lastText = text
      }
    }
  } catch (err) {
    // Leave lastText unset on failure so the next change retries it.
    console.warn('[render] upgrade failed:', (err as Error)?.message ?? err)
  } finally {
    renderInFlight = false
    if (renderDirty) scheduleGlassesRender()
  }
}

function forceRender() {
  lastText = ''
  scheduleGlassesRender()
}

// ── STT lifecycle ────────────────────────────────────────────────────────────
let stt: SttClient | null = null
let streamGeneration = 0
let streamLive = false
let micOn = false

function isCurrentStream(generation: number) {
  return generation === streamGeneration && !cleanedUp
}

function stopMicrophone() {
  if (!micOn) return
  micOn = false
  void serial('audioOff', () => bridge.audioControl(false)).then(ok => {
    if (!ok) console.warn('The glasses did not confirm microphone shutdown.')
  }).catch(err => console.warn('Failed to stop microphone:', err))
}

function failStream(generation: number, err: unknown) {
  if (!isCurrentStream(generation)) return
  // Invalidate callbacks before close() emits its final status.
  streamGeneration++
  streamLive = false
  const failed = stt
  stt = null
  stopMicrophone()
  failed?.close()
  setStatus('error', `STT: ${err instanceof Error ? err.message : String(err)}`)
  console.error('STT error:', err)
}

function startMicrophone(generation: number) {
  if (micOn || !startupReady || !foreground || !isCurrentStream(generation)) return
  micOn = true
  void serial('audioOn', () => {
    // A queued start may have been superseded by backgrounding or new settings.
    if (!micOn || !streamLive || !foreground || !isCurrentStream(generation)) return Promise.resolve(true)
    return bridge.audioControl(true)
  }).then(ok => {
    if (!ok) throw new Error('The glasses could not start the microphone.')
    if (micOn && streamLive && foreground && isCurrentStream(generation)) {
      setStatus('listening', 'Microphone live · double-tap the temple to exit')
    }
  }).catch(err => failStream(generation, err))
}

function applySettings() {
  if (cleanedUp) return
  const generation = ++streamGeneration
  const previous = stt
  stt = null
  streamLive = false
  stopMicrophone()
  previous?.close()
  if (!startupReady || !foreground) return
  setOutputMode(settings.outputMode)

  if (!settings.serverUrl) {
    currentText = 'Open this app on your phone → Settings, and add your WhisperLiveKit server URL.'
    forceRender()
    setStatus('setup', 'Add your WhisperLiveKit server URL in Settings')
    return
  }

  try {
    const client = startSttStream(
      {
        serverUrl: settings.serverUrl,
        splitSentences: settings.splitSentences,
        speakerLabels: settings.speakerLabels,
      },
      ({ finalText, interimText }) => {
        if (!isCurrentStream(generation)) return
        rawText = finalText + interimText
        recomputeDisplay()
        setTranslation(finalText, interimText)
        scheduleGlassesRender()
      },
      err => failStream(generation, err),
      status => {
        if (!isCurrentStream(generation)) return
        streamLive = status === 'live'
        if (status === 'live') {
          startMicrophone(generation)
        } else if (status === 'connecting') {
          setStatus('connecting', 'Connecting to WhisperLiveKit…')
        } else if (status === 'reconnecting') {
          stopMicrophone()
          setStatus('reconnecting', 'Reconnecting…')
        } else if (status === 'closed') {
          stopMicrophone()
          // Retain a drained background session until resume closes it. Fatal
          // errors already invalidated this callback and keep their error text.
          if (foreground) {
            stt = null
            setStatus('setup', 'Audio session ended. Save Settings to reconnect.')
          }
        }
      },
    )
    if (isCurrentStream(generation)) stt = client
    else client.close()
  } catch (err) {
    failStream(generation, err)
  }
}

async function handleSave(next: AppSettings) {
  if (cleanedUp) return
  const prev = settings
  settings = next
  void serial('saveSettings', () => bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(next))).catch(err =>
    console.error('Failed to persist settings:', err),
  )

  const needRebuild = next.widthPct !== prev.widthPct
  const needRestart = !stt ||
    next.serverUrl !== prev.serverUrl ||
    next.outputMode !== prev.outputMode ||
    next.splitSentences !== prev.splitSentences ||
    next.speakerLabels !== prev.speakerLabels

  try {
    if (needRestart) {
      rawText = ''
      setTranslation('', '')
    }
    if (needRebuild) await applyLayout()
    if (cleanedUp) return
    recomputeDisplay()
    forceRender()
    if (needRestart) applySettings()
  } catch (err) {
    setStatus('error', `Display: ${err instanceof Error ? err.message : String(err)}`)
    console.error('Failed to apply settings:', err)
  }
}

// ── Cleanup + event routing ──────────────────────────────────────────────────
let unsubscribe = () => {}
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  foreground = false
  streamGeneration++
  streamLive = false
  stopMicrophone()
  stt?.close()
  stt = null
  if (renderTimer !== null) window.clearTimeout(renderTimer)
  renderTimer = null
  renderDirty = false
  unsubscribe()
}

mountUi({ settings, onSave: handleSave })

// Listen before starting either the page or microphone so the first PCM frame
// cannot arrive before an event handler exists.
unsubscribe = bridge.onEvenHubEvent(event => {
  if (cleanedUp) return
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    cleanup()
    void serial('exit', () => bridge.shutDownPageContainer(1)).catch(err =>
      console.warn('Failed to close the glasses page:', err),
    )
    return
  }

  // Stop capturing but let WhisperLiveKit flush the last spoken words.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    foreground = false
    streamLive = false
    stopMicrophone()
    try {
      stt?.finish()
    } catch (err) {
      failStream(streamGeneration, err)
    }
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    foreground = true
    forceRender()
    applySettings()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
    return
  }

  const pcm = event.audioEvent?.audioPcm
  if (pcm && micOn && foreground) {
    try {
      stt?.sendPcm(pcm)
    } catch (err) {
      failStream(streamGeneration, err)
    }
  }
})

window.addEventListener('beforeunload', cleanup)

try {
  const created = await serial('createStartUpPage', () =>
    bridge.createStartUpPageContainer(new CreateStartUpPageContainer(buildLayout())),
  )
  if (created !== 0) throw new Error(`createStartUpPageContainer failed: ${created}`)
  startupReady = true
  if (!cleanedUp && foreground) applySettings()
} catch (err) {
  setStatus('error', err instanceof Error ? err.message : String(err))
  console.error('Failed to create startup page:', err)
}
