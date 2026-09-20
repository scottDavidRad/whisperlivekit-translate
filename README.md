# WhisperLiveKit Translate + Conversate

Automatic speech captions, English translation, speaker labels, and optional AI conversation assistance for Even Realities G2. Speech processing uses your own [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) server.

This is [Scott Rad's fork](https://github.com/scottDavidRad/whisperlivekit-translate) of [Intel Chen's Soniox Translate](https://github.com/intelc/soniox-translate). No Soniox account, API key, or service is used. The original copyright and [MIT license](LICENSE) are retained.

## Open and speak

A preconfigured installation connects to its server and starts listening automatically. **Auto** is the default source language. Choose a language in **From** only when you want manual recognition; return to Auto at any time.

- **Translate** displays English translation with optional speaker labels. English is the supported translation target.
- **Conversate** keeps source-language captions and adds AI cues, optional Prep notes, and a summary with action items after End. Its AI provider must be configured on the backend.
- **Pause** stops microphone capture and immediately clears the glasses. The phone keeps the current session text. **Resume** continues; **End** or a double-tap on the temple finishes the session, including final speech and the Conversate summary. Start appears after a session has ended.
- Glasses show **confirmed speech on steady pages**. Rows stay in place as a page fills, then the whole page advances after a 2.5-second reading pause. Updates are at least 700 milliseconds apart, and continuing speech repeats its speaker label on the next page. The phone keeps live wording, including text still being revised.
- **Clear captions after** offers 3, 5, 10, or 15 seconds after the last displayed caption update, or **Stay until replaced**. The default is 5 seconds. Pause clears the lens in either case.
- Conversate's **Auto pop-up** and separate **Cue duration** control AI cues on the glasses. You can also use **Show on glasses** for a received cue.

The phone interface follows the layout and neutral colors of the native [Translate](https://support.evenrealities.com/hc/en-us/articles/14273831059983-Translate) and [Conversate](https://support.evenrealities.com/hc/en-us/articles/14273795154319-Conversate) references: language controls, readable session text, settings, and Pause/End controls. Translate shows up to **eight lines** on the lens at the native font size. Conversate shows **five caption lines**, with a separate three-line AI cue area above. The default Auto line count fills the available caption area. This is an independent Even Hub implementation. It cannot replace the glasses operating system's built-in Translate or Conversate applications. It does not provide reverse-direction translation, simultaneous original/translated streams, or Even account history integration.

Automatic source selection covers languages supported by the selected multilingual Whisper model. It does not cover every language in the world. Recognition, translation, and speaker attribution can be imperfect. The app does not claim to display the model's detected language code.

## Installation for the operator

The user of a configured app does not need to enter an endpoint or provider key. The generic source checkout and CI package leave the endpoint unset; the operator supplies it when deploying.

Requirements:

- Node.js 24.15+ in the 24.x line, 26+, or 22.22.2+ in the 22.x line, with npm.
- Python 3.12 for the speech server.
- A server reachable from the phone, normally over a private LAN or tailnet.
- The Even companion app and G2 glasses, or the official desktop simulator.
- `ffmpeg` for speech smoke tests; macOS `say` or a recorded speech file provides test input.

```sh
git clone https://github.com/scottDavidRad/whisperlivekit-translate.git
cd whisperlivekit-translate
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run server
```

Run the supplied launcher, which includes this fork's connection adapter. It supports source language and speech task per connection while sharing the loaded Whisper model. The client checks the server's acknowledgment before enabling the microphone. A stock `wlk` endpoint without this adapter does not implement the same language/task handshake.

The launcher enables raw PCM input, automatic source selection, English translation, and Sortformer speaker diarization by default. Model files download when first needed. NeMo and its public NVIDIA diarization model increase installation size and startup time.

Optional server choices:

```sh
# Original-language transcription as the server default.
WLK_TASK=transcribe npm run server

# Disable diarization to reduce resource use.
WLK_DIARIZATION=0 npm run server

# Choose a multilingual Whisper model.
npm run server -- --model small

# Apple silicon: use MLX GPU speech inference.
WLK_BACKEND=mlx-whisper npm run server
```

The standard launcher uses faster-whisper on CPU. The requirements also install MLX Whisper on Apple silicon; select it with `WLK_BACKEND=mlx-whisper`. The adapter forwards each connection's speech task to MLX and keeps its decode context independent. English-only `.en` models are unsuitable for multilingual translation. Bigger models and extra diarization work require more resources. See [VERIFICATION.md](VERIFICATION.md) for measured results and performance limits rather than assuming real-time performance on every computer.

Sortformer uses `nvidia/diar_streaming_sortformer_4spk-v2`, supporting up to four voices per connection. **Speaker 1**, **Speaker 2**, and **Speaker pending** are anonymous voice labels, not personal identities. Returning from the background keeps the session text but starts fresh voice numbering for the new connection; voices are not matched across connections.

## Deploy the phone app

Set `VITE_WHISPERLIVEKIT_URL` in `.env.local` before starting or building the app. Use the actual reachable server address, such as `ws://192.168.1.20:8000/asr` on an HTTP LAN deployment or `wss://<mini-tailnet-hostname>:18443/asr` through private TLS hosting. This is a client-visible URL, not a secret.

```sh
npm run dev
npm run simulate
```

For the phone and glasses, generate a QR code using the app host's LAN address:

```sh
npx @evenrealities/evenhub-cli qr --url "http://192.168.1.20:5173"
```

Open it through the Even companion app's developer mode. A normal browser lacks the Even SDK bridge; use the simulator or companion app for the full application.

The Settings button provides an operator endpoint override and optional display preferences. A saved endpoint takes precedence over the build default. Existing saved preferences are retained. `localhost` on a phone refers to the phone itself.

## Conversate providers

Conversate offers **Codex**, **Grok**, **Qwen 3.8**, and **OpenAI-compatible** choices in Settings, with Codex selected by default. Credentials and provider configuration stay on the backend. The phone shows whether the selected provider is ready or what configuration is missing.

Prep notes are optional and limited to 5,000 characters in the phone UI. AI cues and summaries use the conversation and these notes; no biographies, notes, or suggested actions are prefilled. Generated assistance can be wrong, so review it before relying on it.

For a Mac service deployment, copy [server.env.example](server.env.example) to `server.env` on the backend host and add only the selected provider's configuration. Keep that file private (`chmod 600 server.env`). The installer reads it as data and stores provider settings in a private service file rather than the launchd plist. Re-run the installer after changing provider settings. For a foreground `npm run server` process, supply these variables in that process's environment.

Backend configuration supports:

| Selection | Backend configuration |
|---|---|
| Codex | Authenticated Codex CLI 0.136.0+ with isolated conversation support on the backend host; optional `CODEX_BIN` and `CODEX_MODEL` overrides |
| Grok | `XAI_API_KEY`; optional `GROK_MODEL` |
| Qwen 3.8 | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` for the official endpoint; optional `QWEN_BASE_URL` and `QWEN_MODEL` |
| OpenAI-compatible | `CONVERSATION_BASE_URL`, `CONVERSATION_MODEL`, and `CONVERSATION_API_KEY`; supported official-host key fallbacks are available |

Codex was tested using the backend host's saved ChatGPT login and the `gpt-5.5` model. Available models depend on the authenticated account. The cloud-provider request formats are tested, but live Grok, Qwen, and generic OpenAI-compatible responses have not been verified in this deployment.

For an explicitly trusted custom endpoint that requires no key, the operator can enable `CONVERSATION_ALLOW_KEYLESS=1`. Never put provider credentials in Vite variables or the phone settings. A provider appearing in the selection list does not mean that account is configured; see the verification record for providers actually tested.

## Run the backend on a Mac mini

A backend can run separately from the phone-app host. Install the project and Python environment on the serving Mac, for example under `$HOME/whisperlivekit-backend`. The repository includes a per-user launchd installer:

```sh
cd "$HOME/whisperlivekit-backend"
WLK_BACKEND=mlx-whisper WLK_CHUNK_SIZE=1 ./scripts/install-mac-service.sh 127.0.0.1 18768
launchctl print "gui/$(id -u)/com.scottrad.whisperlivekit"
launchctl kickstart -k "gui/$(id -u)/com.scottrad.whisperlivekit"
```

This example selects GPU inference on Apple silicon. The service uses the project environment, restarts through launchd, and rotates `$HOME/whisperlivekit-backend/logs/server.log`. A private TLS gateway can expose that loopback service as `wss://<mini-tailnet-hostname>:18443/asr` to authorized tailnet devices. Configure the deployed app with that endpoint once. No machine-specific address or credentials are included in this repository.

On the tested M4 Mac mini, four recordings reached their final result in 8.93–29.08 seconds for 7.85–27.66 seconds of audio, including trailing silence. First ASR text results, including provisional wording, arrived in about 1.6–1.7 seconds after warm-up and 4.92 seconds on the cold first run. Confirmed glasses pages can appear later; these measurements predate the steady-page display and do not measure its latency. See the [complete measurements](VERIFICATION.md#mac-mini-private-speech-backend-mlx-gpu); performance varies with speech and server load.

## Network and privacy

Microphone audio goes to the configured WhisperLiveKit server for speech processing. When Conversate assistance is enabled, transcript excerpts and Prep notes go from the backend to the selected AI provider. Provider credentials remain on the backend.

Use `ws://` with an HTTP app on a trusted LAN. An HTTPS app requires a `wss://` endpoint with a trusted certificate. Keep the server private or protect it with TLS and appropriate access controls. The development launcher and Mac service example bind to loopback by default. To serve directly on a trusted LAN or tailnet, explicitly pass `--host` with that interface's address, for example `npm run server -- --host <private-interface-ip>`.

`app.json` contains microphone and network permissions and no Soniox domain. Some Even Hub deployments may require an allowlist for the actual backend host. Configure that for the deployment.

## Verify and package

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
npm run pack
```

The package is `whisperlivekit-translate.ehpk`. Build before packing. The checks and remaining limits are recorded in [VERIFICATION.md](VERIFICATION.md).

The current verification includes 69 client tests, 27 backend tests, four real speech recordings through the private Mac mini, a complete Conversate speech-plus-Codex test, the Russian confirmed-page application path, and Russian translation visible in the native simulator. Physical G2 hardware has not been tested.

The speech smoke test uses the same WebSocket client as the app, streams real speech, and waits for final server acknowledgment:

```sh
# macOS: generates speech with say and converts it with ffmpeg.
EXPECT_TEXT='quick brown fox' npm run smoke -- "The quick brown fox jumps over the lazy dog."

# Any platform with ffmpeg and a speech recording.
AUDIO_FILE=/path/to/speech.wav npm run smoke

# Russian, with Auto left enabled on the backend.
SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."

# A recording containing at least two distinct voices.
SPEAKER_LABELS=1 EXPECT_SPEAKERS=2 AUDIO_FILE=/path/to/two-speakers.wav npm run smoke
```

Set `WHISPERLIVEKIT_URL` for a different endpoint. `EXPECT_TEXT` is a case-insensitive regular expression checked against final text; `EXPECT_SPEAKERS` checks distinct displayed labels, not word-by-word attribution accuracy.

The full application smoke test additionally runs `main.ts` and the actual SDK event parser, with a stubbed native microphone/glasses bridge:

```sh
OUTPUT_MODE=translation WHISPERLIVEKIT_URL=ws://127.0.0.1:8000/asr \
  SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke:app -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

To include real Conversate assistance and its post-session summary, configure the backend provider and use a meeting recording:

```sh
APP_MODE=conversate AI_PROVIDER=codex EXPECT_SUMMARY=1 \
  AUDIO_FILE=/path/to/meeting.wav npm run smoke:app
```

This harness checks the software path using a stubbed native bridge; use the official simulator or physical glasses to verify their microphone and display behavior.

## Project layout

| Path | Purpose |
|---|---|
| `src/asr/stt.ts` | WhisperLiveKit protocol, audio streaming, snapshots, shutdown |
| `src/main.ts` | Even SDK lifecycle, captions, lens layout, session actions |
| `src/ui.ts`, `src/settings.ts`, `src/languages.ts` | Phone controls and preferences |
| `src/conversation.ts`, `src/caption-timing.ts` | AI request lifecycle and caption retention |
| `server/` | Speech connection adapter and backend-only AI assistance |
| `scripts/` | Server launch, Mac service installation, speech smoke tests |
| `tests/` | Protocol, UI, lifecycle, timing, and provider checks |

Historical upstream screenshots do not represent this fork. This project is not affiliated with or endorsed by Even Realities, Soniox, or the WhisperLiveKit maintainers.
