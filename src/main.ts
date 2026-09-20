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
import { mountUi, setStatus, setTranslation, setOutputMode, setSessionState, setAppMode, setConversationCue, setConversationStatus, setConversationSummary } from './ui'
import { CaptionTiming } from './caption-timing'
import { CaptionPager } from './caption-pager'
import { ConversationSession, conversationRequest, type ConversationCue, type ConversationConfig, type ConversationSummary } from './conversation'
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
let sessionState: 'listening' | 'paused' | 'ended' = 'listening'

// ── Render state ─────────────────────────────────────────────────────────────
let currentText = 'Starting…'
let lastText = ''
let rawText = ''
let committedText = ''
let captionPage = ''
const captionTiming = new CaptionTiming(settings.captionHoldSeconds, () => { recomputeDisplay(); scheduleGlassesRender() })
let latestCue: ConversationCue | null = null
let cueText = ''
let lastCueText = ''
let cueTimer: number | undefined
let aiSession: ConversationSession | undefined
let aiGeneration = 0
let aiController: AbortController | undefined
let summaryStarted = false
let aiAvailable = false
let speechDrained = true
let aiRetryTimer: number | undefined

function effectiveOutputMode() {
  return settings.appMode === 'conversate' ? 'transcript' : settings.outputMode
}

// ── Layout / geometry (one borderless, width-aware pane) ──────────────────────
const PAD = 3
const LINE_H = 27
const spaceW = Math.max(1, getTextWidth('a a') - getTextWidth('aa'))

let headerY = 0
let textY = 40
let textH = 248
let paneLines = 8
let paneW = 528
let paneX = 24
let innerW = 522

function updateGeometry() {
  const conversate = settings.appMode === 'conversate'
  headerY = conversate ? 90 : 0
  textY = conversate ? 128 : 40
  textH = 288 - textY
  paneLines = Math.floor((textH - 2 * PAD) / LINE_H)
  paneW = Math.round((528 * (settings.widthPct || 100)) / 100)
  paneX = Math.round((576 - paneW) / 2)
  innerW = paneW - 2 * PAD
}
updateGeometry()

function buildLayout() {
  return {
    containerTotalNum: settings.appMode === 'conversate' ? 3 : 2,
    textObject: [new TextContainerProperty({
      xPosition: paneX, yPosition: headerY, width: paneW, height: 32,
      borderWidth: 0, paddingLength: 2,
      containerID: 2, containerName: 'direction',
      content: `${settings.sourceLanguage.toUpperCase()}>${effectiveOutputMode() === 'translation' ? 'EN' : 'TEXT'}`,
      isEventCapture: 0,
    }), new TextContainerProperty({
      xPosition: paneX, yPosition: textY, width: paneW, height: textH,
      borderWidth: 0, paddingLength: PAD,
      containerID: 1, containerName: 'output', content: currentText, isEventCapture: 1,
    }), ...(settings.appMode === 'conversate' ? [new TextContainerProperty({
      xPosition: paneX, yPosition: 0, width: paneW, height: 87,
      borderWidth: 0, paddingLength: PAD, containerID: 3, containerName: 'cue',
      content: cueText || ' ', isEventCapture: 0,
    })] : [])],
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

function visibleCaptionLines() {
  return settings.maxLines > 0 ? Math.min(paneLines, settings.maxLines) : paneLines
}

function wrapCaptionText(text: string): string[] {
  const paragraphs = (settings.splitSentences ? splitSentences(text) : text).trim().split('\n')
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (lines.length) for (let i = 0; i < settings.lineGap; i++) lines.push('')
    lines.push(...wrapToLines(paragraph, innerW))
  }
  return lines
}

const captionPager = new CaptionPager({ rows: visibleCaptionLines(), wrap: wrapCaptionText }, text => {
  if (cleanedUp || !foreground || sessionState !== 'listening') return
  captionPage = text
  // A new page may repeat the same words; its reading time still starts now.
  captionTiming.reset()
  captionTiming.update(text)
  recomputeDisplay()
  scheduleGlassesRender()
})

function recomputeDisplay() {
  if (sessionState !== 'listening' || captionTiming.hidden) {
    currentText = ' '
    return
  }
  let lines = (captionPage || (effectiveOutputMode() === 'translation' ? 'Translation…' : 'Listening…')).split('\n')
  if (settings.align === 'center') lines = lines.map(centerLine)
  // Anchor the entire page area, never the current number of words/rows.
  // Appending speech therefore leaves every earlier line in the same place.
  if (settings.vAlign === 'bottom') {
    lines = new Array(Math.max(0, paneLines - visibleCaptionLines())).fill(' ').concat(lines)
  }
  currentText = lines.join('\n')
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
      if (settings.appMode === 'conversate' && cueText !== lastCueText) {
        const text = cueText
        const upgraded = await serial('upgrade.cue', () => bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 3, containerName: 'cue', content: text || ' ',
        })))
        if (!upgraded) throw new Error('The AI cue could not be updated.')
        lastCueText = text
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
  lastCueText = '\0'
  scheduleGlassesRender()
}

function clearCue() {
  window.clearTimeout(cueTimer)
  cueText = ''
  scheduleGlassesRender()
}

function showLatestCue() {
  if (!latestCue || settings.appMode !== 'conversate' || sessionState !== 'listening' || !foreground) return
  window.clearTimeout(cueTimer)
  const lines = wrapToLines(latestCue.text, innerW)
  const body = lines.slice(0, 2)
  if (lines.length > 2) body[1] = body[1].replace(/\s+\S*$/, '') + '…'
  cueText = `${latestCue.kind.toUpperCase()}\n${body.join('\n')}`
  scheduleGlassesRender()
  cueTimer = window.setTimeout(clearCue, settings.cueDurationSeconds * 1000)
}

function stopConversation() {
  aiGeneration++
  window.clearTimeout(aiRetryTimer)
  aiController?.abort()
  aiController = undefined
  aiSession?.dispose()
  aiSession = undefined
  aiAvailable = false
  latestCue = null
  clearCue()
}

async function configureConversation() {
  stopConversation()
  summaryStarted = false
  setAppMode(settings.appMode)
  setOutputMode(effectiveOutputMode())
  setConversationCue(null)
  setConversationSummary('', [])
  if (settings.appMode !== 'conversate' || !settings.serverUrl || cleanedUp) return
  const generation = aiGeneration
  aiController = new AbortController()
  setConversationStatus('Connecting to AI assistance…')
  try {
    const config = await conversationRequest<ConversationConfig>(settings.serverUrl, 'config', undefined,
      aiController.signal, settings.aiProvider)
    if (generation !== aiGeneration || cleanedUp) return
    if (!config.configured) {
      setConversationStatus(config.reason || 'Configure this AI provider on the backend to enable assistance.')
      aiRetryTimer = window.setTimeout(() => { void configureConversation() }, 30_000)
      return
    }
    aiAvailable = true
    setConversationStatus(`${config.provider} · ${config.model}`)
    aiSession = new ConversationSession({
      serverUrl: settings.serverUrl, prepNotes: settings.prepNotes, provider: settings.aiProvider,
      onCue(cue) {
        if (generation !== aiGeneration || sessionState !== 'listening' || !foreground) return
        latestCue = cue
        setConversationCue(cue)
        if (settings.cueAutoShow) showLatestCue()
      },
      onStatus(message) { if (generation === aiGeneration) setConversationStatus(message) },
    })
    if (sessionState !== 'listening' || !foreground) aiSession.pause()
    else aiSession.update(committedText)
    if (sessionState === 'ended') void summarizeSession()
  } catch (error) {
    if (generation === aiGeneration) {
      setConversationStatus(error instanceof Error ? error.message : 'AI assistance is unavailable.')
      aiRetryTimer = window.setTimeout(() => { void configureConversation() }, 30_000)
    }
  }
}

async function summarizeSession() {
  if (settings.appMode !== 'conversate' || summaryStarted || !speechDrained || !rawText.trim() || cleanedUp) return
  if (!aiAvailable) return
  summaryStarted = true
  const generation = aiGeneration
  setConversationStatus('Preparing your summary…')
  try {
    const result = await conversationRequest<ConversationSummary>(settings.serverUrl, 'summary', {
      transcript: rawText.slice(-48_000), prep_notes: settings.prepNotes, provider: settings.aiProvider,
    }, aiController?.signal)
    if (generation !== aiGeneration || cleanedUp) return
    if (typeof result.summary !== 'string' || !Array.isArray(result.action_items) ||
      result.action_items.some(item => typeof item !== 'string')) throw new Error('AI service returned an invalid summary.')
    setConversationSummary(result.summary, result.action_items)
    setConversationStatus('Session summary ready')
  } catch (error) {
    if (generation === aiGeneration) {
      summaryStarted = false
      setConversationStatus(error instanceof Error ? error.message : 'Summary is unavailable.')
    }
  }
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
  speechDrained = true
  setStatus('error', `STT: ${err instanceof Error ? err.message : String(err)}`)
  console.error('STT error:', err)
  if (sessionState === 'ended') void summarizeSession()
}

function startMicrophone(generation: number) {
  if (micOn || !startupReady || !foreground || sessionState !== 'listening' || !isCurrentStream(generation)) return
  micOn = true
  void serial('audioOn', () => {
    // A queued start may have been superseded by backgrounding or new settings.
    if (!micOn || !streamLive || !foreground || sessionState !== 'listening' || !isCurrentStream(generation)) return Promise.resolve(true)
    return bridge.audioControl(true)
  }).then(ok => {
    if (!ok) throw new Error('The glasses could not start the microphone.')
    if (micOn && streamLive && foreground && isCurrentStream(generation)) {
      setStatus('listening', 'Microphone live · double-tap the temple to end')
      if (!rawText) { recomputeDisplay(); scheduleGlassesRender() }
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
  if (!startupReady || !foreground || sessionState !== 'listening') return
  setSessionState(sessionState)
  setOutputMode(effectiveOutputMode())
  setAppMode(settings.appMode)

  if (!settings.serverUrl) {
    currentText = 'Open this app on your phone → Settings, and add your WhisperLiveKit server URL.'
    forceRender()
    setStatus('setup', 'Add your WhisperLiveKit server URL in Settings')
    return
  }

  try {
    speechDrained = false
    let previousFinal = ''
    let previousInterim = ''
    const prefix = committedText
    const previousSpeakerIds = [...prefix.matchAll(/Speaker (\d+):/g)].map(match => Number(match[1]))
    const client = startSttStream(
      {
        serverUrl: settings.serverUrl,
        sourceLanguage: settings.sourceLanguage,
        task: effectiveOutputMode() === 'translation' ? 'translate' : 'transcribe',
        splitSentences: settings.splitSentences,
        speakerLabels: settings.speakerLabels,
        firstSpeaker: Math.max(0, ...previousSpeakerIds) + 1,
      },
      ({ finalText, interimText, finished }) => {
        if (!isCurrentStream(generation)) return
        if (!finished && finalText === previousFinal && interimText === previousInterim) return
        previousFinal = finalText
        previousInterim = interimText
        if (prefix) finalText = prefix + (finalText ? '\n' + finalText : '')
        rawText = finalText + interimText
        committedText = finalText
        if (sessionState === 'listening' && foreground) captionPager.update(finalText)
        if (settings.appMode === 'conversate' && sessionState === 'listening') aiSession?.update(finalText)
        recomputeDisplay()
        setTranslation(finalText, interimText)
        scheduleGlassesRender()
        if (finished) speechDrained = true
        if (finished && sessionState === 'ended') void summarizeSession()
      },
      err => failStream(generation, err),
      status => {
        if (!isCurrentStream(generation)) return
        streamLive = status === 'live'
        if (status === 'live') {
          startMicrophone(generation)
        } else if (status === 'connecting') {
          if (sessionState === 'listening') setStatus('connecting', 'Connecting…')
        } else if (status === 'reconnecting') {
          stopMicrophone()
          if (sessionState === 'listening') setStatus('reconnecting', 'Reconnecting…')
        } else if (status === 'closed') {
          stopMicrophone()
          // Retain a drained background session until resume closes it. Fatal
          // errors already invalidated this callback and keep their error text.
          if (foreground) {
            stt = null
            if (sessionState === 'listening') setStatus('setup', 'Audio session ended. Save Settings to reconnect.')
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
  updateGeometry()
  void serial('saveSettings', () => bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(next))).catch(err =>
    console.error('Failed to persist settings:', err),
  )

  const needRebuild = next.appMode !== prev.appMode || next.widthPct !== prev.widthPct || next.sourceLanguage !== prev.sourceLanguage || next.outputMode !== prev.outputMode
  const speechChanged = next.appMode !== prev.appMode ||
    next.serverUrl !== prev.serverUrl ||
    next.sourceLanguage !== prev.sourceLanguage ||
    next.outputMode !== prev.outputMode ||
    next.splitSentences !== prev.splitSentences ||
    next.speakerLabels !== prev.speakerLabels
  const needRestart = sessionState !== 'ended' && (!stt || speechChanged)

  try {
    captionTiming.configure(settings.captionHoldSeconds)
    if (next.appMode !== prev.appMode || next.serverUrl !== prev.serverUrl || next.aiProvider !== prev.aiProvider || next.prepNotes !== prev.prepNotes) void configureConversation()
    if (needRestart) {
      streamGeneration++
      streamLive = false
      stopMicrophone()
      const previous = stt
      stt = null
      previous?.close()
    }
    if (speechChanged) {
      rawText = ''
      committedText = ''
      captionPage = ''
      captionPager.reset()
      captionTiming.reset()
      summaryStarted = false
      setTranslation('', '')
    }
    if (needRebuild || next.maxLines !== prev.maxLines || next.lineGap !== prev.lineGap || next.splitSentences !== prev.splitSentences) {
      captionPager.configure({ rows: visibleCaptionLines(), wrap: wrapCaptionText })
    }
    recomputeDisplay()
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
  stopConversation()
  captionPager.dispose()
  captionTiming.dispose()
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

function handleSessionAction(action: 'pause' | 'resume' | 'end' | 'start') {
  if (cleanedUp) return
  if (action === 'pause') {
    sessionState = 'paused'
    captionPager.suspend()
    stopMicrophone()
    setStatus('setup', 'Paused')
    setSessionState('paused')
    aiSession?.pause()
    clearCue()
    captionTiming.clear()
    return
  }
  if (action === 'resume') {
    sessionState = 'listening'
    captionPager.resume()
    setSessionState('listening')
    aiSession?.resume()
    if (stt && streamLive) startMicrophone(streamGeneration)
    else applySettings()
    return
  }
  if (action === 'end') {
    sessionState = 'ended'
    captionPager.suspend()
    stopMicrophone()
    setStatus('setup', 'Session ended')
    setSessionState('ended')
    aiSession?.pause()
    clearCue()
    captionTiming.clear()
    if (!stt) { speechDrained = true; void summarizeSession() }
    try { stt?.finish() } catch (err) { failStream(streamGeneration, err) }
    return
  }
  sessionState = 'listening'
  rawText = ''
  committedText = ''
  captionPage = ''
  captionPager.reset()
  captionTiming.reset()
  summaryStarted = false
  void configureConversation()
  setTranslation('', '')
  setSessionState('listening')
  recomputeDisplay()
  forceRender()
  applySettings()
}

mountUi({ settings, onSave: handleSave, onSessionAction: handleSessionAction, onCueAction: showLatestCue })
void configureConversation()

// Listen before starting either the page or microphone so the first PCM frame
// cannot arrive before an event handler exists.
unsubscribe = bridge.onEvenHubEvent(event => {
  if (cleanedUp) return
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    handleSessionAction('end')
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (settings.appMode === 'conversate') showLatestCue()
  }

  // Stop capturing but let WhisperLiveKit flush the last spoken words.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    foreground = false
    captionPager.suspend()
    aiSession?.pause()
    clearCue()
    captionTiming.clear()
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
    if (sessionState === 'listening') { captionPager.resume(); aiSession?.resume() }
    forceRender()
    applySettings()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
    return
  }

  const pcm = event.audioEvent?.audioPcm
  if (pcm && micOn && foreground && sessionState === 'listening') {
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
