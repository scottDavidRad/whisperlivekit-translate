#!/usr/bin/env node
// Exercises the SAME client used by the glasses with real speech audio.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startSttStream, type SttClient } from '../src/asr/stt.ts'

const url = process.env.WHISPERLIVEKIT_URL || 'ws://127.0.0.1:8000/asr'
const text = process.argv[2] || 'The quick brown fox jumps over the lazy dog.'
const temp = mkdtempSync(join(tmpdir(), 'whisperlivekit-smoke-'))
let client: SttClient | undefined
try {
  let input = process.env.AUDIO_FILE
  if (!input) {
    if (process.platform !== 'darwin') throw new Error('Set AUDIO_FILE to a speech recording on systems without macOS say.')
    input = join(temp, 'speech.aiff')
    execFileSync('say', [...(process.env.SAY_VOICE ? ['-v', process.env.SAY_VOICE] : []), '-o', input, '--', text])
  }
  const pcmPath = join(temp, 'speech.pcm')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-f', 's16le', pcmPath])
  // Include a second of silence so VAD sees the end of the utterance.
  const pcm = Buffer.concat([readFileSync(pcmPath), Buffer.alloc(32000)])
  let finalText = ''
  let snapshots = 0
  let interimSnapshots = 0
  let resolveReady: () => void
  let rejectReady: (error: unknown) => void
  let resolveDone: () => void
  let rejectDone: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  // Attach immediately so connection failures never produce unhandled rejections.
  void done.catch(() => {})
  const timeout = setTimeout(() => {
    const error = new Error('Speech smoke test timed out after 120 seconds.')
    rejectReady(error)
    rejectDone(error)
  }, 120_000)
  try {
    client = startSttStream({ serverUrl: url, splitSentences: true }, snapshot => {
      snapshots++
      if (snapshot.interimText.trim()) interimSnapshots++
      finalText = snapshot.finalText.trim()
      if (snapshot.finished) resolveDone()
    }, error => { rejectReady(error); rejectDone(error) }, status => {
      if (status === 'live') resolveReady()
    })
    await ready
    console.log(`Streaming ${(pcm.length / 32000).toFixed(1)} seconds of PCM to ${url}`)
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      client.sendPcm(pcm.subarray(offset, offset + 3200))
      await sleep(100)
    }
    client.finish()
    await done
    if (!finalText) throw new Error('WhisperLiveKit finished without recognizing speech.')
    if (process.env.EXPECT_TEXT && !new RegExp(process.env.EXPECT_TEXT, 'i').test(finalText)) {
      throw new Error(`Transcript did not match EXPECT_TEXT: ${finalText}`)
    }
    console.log(JSON.stringify({ passed: true, url, snapshots, interimSnapshots, finalText }, null, 2))
  } finally { clearTimeout(timeout) }
} finally {
  client?.close()
  rmSync(temp, { recursive: true, force: true })
}
