#!/usr/bin/env node
// Soniox real-time smoke test — validates your API key, model, and the exact
// pcm_s16le @ 16kHz mono streaming path the glasses app uses, independent of
// any Even Hub hardware/simulator. Optionally validates real-time TRANSLATION.
//
// Generates speech with macOS `say`, converts to raw PCM with `afconvert`,
// streams it to Soniox in ~100ms chunks, and prints the transcript (and, in
// translate mode, the original + translated streams separately).
//
// Usage:
//   node scripts/soniox-smoke.mjs ["text to speak"]
//   SONIOX_TRANSLATE_TO=en SAY_VOICE=Mónica \
//     node scripts/soniox-smoke.mjs "Hola, esto es una prueba de traducción."
//
// Env:
//   SONIOX_API_KEY     key (else read from .env.local's VITE_STT_API_KEY)
//   SONIOX_MODEL       default stt-rt-v4
//   SONIOX_TRANSLATE_TO  e.g. "en" → enable one-way translation
//   SONIOX_LANGUAGES   comma-separated source hints (default: en, or none in translate mode)
//   SAY_VOICE          macOS voice, e.g. "Mónica" (es), "Thomas" (fr), "Anna" (de)
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const TEXT = process.argv[2] || 'Testing, one two three. The quick brown fox jumps over the lazy dog.'
const MODEL = process.env.SONIOX_MODEL || 'stt-rt-v4'
const TRANSLATE_TO = (process.env.SONIOX_TRANSLATE_TO || '').trim()
const VOICE = (process.env.SAY_VOICE || '').trim()
const LANG_HINTS = (process.env.SONIOX_LANGUAGES ?? (TRANSLATE_TO ? '' : 'en'))
  .split(',').map(s => s.trim()).filter(Boolean)
const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

function loadKey() {
  if (process.env.SONIOX_API_KEY) return process.env.SONIOX_API_KEY.trim()
  const envPath = new URL('../.env.local', import.meta.url)
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/(?:VITE_STT_API_KEY|SONIOX_API_KEY)\s*=\s*(\S+)/)
    if (m) return m[1].trim()
  }
  return null
}

function pcmFromWav(buf) {
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size & 1)
  }
  return buf.subarray(44)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const key = loadKey()
if (!key) {
  console.error('No Soniox key. Set $SONIOX_API_KEY or SONIOX_API_KEY=... in .env')
  process.exit(1)
}

console.log(`Synthesizing speech${VOICE ? ` (voice ${VOICE})` : ''}: "${TEXT}"`)
const voiceArg = VOICE ? `-v ${JSON.stringify(VOICE)} ` : ''
execSync(`say ${voiceArg}-o /tmp/soniox-test.aiff ${JSON.stringify(TEXT)}`)
execSync('afconvert /tmp/soniox-test.aiff -d LEI16@16000 -c 1 -f WAVE /tmp/soniox-test.wav')
const pcm = pcmFromWav(readFileSync('/tmp/soniox-test.wav'))
console.log(`PCM: ${pcm.length} bytes (${(pcm.length / 2 / 16000).toFixed(1)}s @ 16kHz mono s16le)`)
console.log(`Connecting to Soniox (model ${MODEL}${TRANSLATE_TO ? `, translate→${TRANSLATE_TO}` : ''})…`)

const ws = new WebSocket(SONIOX_URL)
ws.binaryType = 'arraybuffer'
let origFinal = ''
let transFinal = ''

const timeout = setTimeout(() => {
  console.error('Timed out waiting for Soniox "finished".')
  process.exit(1)
}, 45000)

ws.onopen = async () => {
  const config = {
    api_key: key,
    model: MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    enable_endpoint_detection: true,
  }
  if (LANG_HINTS.length) config.language_hints = LANG_HINTS
  if (TRANSLATE_TO) config.translation = { type: 'one_way', target_language: TRANSLATE_TO }
  ws.send(JSON.stringify(config))

  const CHUNK = 3200 // 100 ms
  for (let i = 0; i < pcm.length; i += CHUNK) {
    ws.send(pcm.subarray(i, i + CHUNK))
    await sleep(50)
  }
  ws.send('') // end-of-stream
}

ws.onmessage = ev => {
  const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()
  const res = JSON.parse(raw)
  if (res.error_code) {
    console.error(`Soniox error ${res.error_code} ${res.error_type ?? ''}: ${res.error_message ?? ''}`)
    process.exit(1)
  }
  let origInterim = ''
  let transInterim = ''
  for (const t of res.tokens ?? []) {
    if (!t.text || /^<[a-z_]+>$/i.test(t.text)) continue
    const isTranslation = t.translation_status === 'translation'
    if (isTranslation) {
      if (t.is_final) transFinal += t.text
      else transInterim += t.text
    } else {
      if (t.is_final) origFinal += t.text
      else origInterim += t.text
    }
  }
  const line = TRANSLATE_TO
    ? `  orig: ${(origFinal + origInterim).trim().slice(-40).padEnd(42)} → en: ${(transFinal + transInterim).trim().slice(-40)}`
    : `  live: ${(origFinal + origInterim).trim().slice(-70)}`
  process.stdout.write(`\r${line.padEnd(110)}`)
  if (res.finished) {
    clearTimeout(timeout)
    if (TRANSLATE_TO) {
      console.log(`\n\n✅ ORIGINAL:    ${origFinal.trim()}`)
      console.log(`✅ TRANSLATION: ${transFinal.trim()}`)
    } else {
      console.log(`\n\n✅ TRANSCRIPT: ${origFinal.trim()}`)
    }
    ws.close()
    process.exit(0)
  }
}

ws.onerror = e => {
  console.error('\nWebSocket error:', e?.message || e)
  process.exit(1)
}
