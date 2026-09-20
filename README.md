# WhisperLiveKit Translate

Live captions and English speech translation for Even Realities G2 glasses, using a self-hosted [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) server.

This is [Scott Rad's fork](https://github.com/scottDavidRad/whisperlivekit-translate) of [Intel Chen's Soniox Translate](https://github.com/intelc/soniox-translate). The speech connection, settings, and setup have been replaced with WhisperLiveKit. No Soniox account, API key, or service is used.

The app sends microphone audio to your configured server and displays its output in one glasses pane and a companion phone mirror. It supports live captions in the source language or Whisper's native translation into English. Translation is a **server-wide setting**: the app's Transcript / Translation selector labels the output and must match the server. It does not change the model's task. This version does not provide simultaneous original and translated text or arbitrary translation targets.

## Requirements

- Node.js 22.13 or newer, with npm.
- Python 3.12 for the local speech server.
- A computer reachable from the phone, normally on the same private Wi-Fi network.
- The Even Realities companion app and G2 glasses, or the Even Hub desktop simulator.
- `ffmpeg` for the audio smoke test. macOS can generate its test speech with `say`; other systems need a speech recording.

WhisperLiveKit and its inference dependencies are pinned in [requirements.txt](requirements.txt). Model files may download on first launch. Inference speed and recognition accuracy depend on the model, computer, audio, and language.

## Install and start the server

```sh
git clone https://github.com/scottDavidRad/whisperlivekit-translate.git
cd whisperlivekit-translate
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run server
```

The server script binds to `0.0.0.0:8000` and starts WhisperLiveKit with raw PCM input, `faster-whisper`, the `localagreement` streaming policy, and the multilingual `base` model. The source language is detected automatically unless you provide `--lan`.

For Spanish speech translated into English, stop the captions server and start:

```sh
npm run server -- --lan es --direct-english-translation
```

Use a multilingual model for translation, such as `base`; an English-only `.en` model is not suitable. You can override script defaults, for example `npm run server -- --model small --lan es --direct-english-translation`. Larger models require more resources.

Keep `--pcm-input` enabled. The glasses send mono, 16 kHz, signed 16-bit little-endian PCM; the client checks the server's PCM configuration before sending audio. This fork uses native English translation, not WhisperLiveKit 0.2.19's unfinished arbitrary-target translation option.

## Open the app

In a second terminal:

```sh
npm run dev
```

For desktop development:

```sh
npm run simulate
```

For the phone and glasses, replace the address below with your computer's LAN IP:

```sh
npx @evenrealities/evenhub-cli qr --url "http://192.168.1.20:5173"
```

Open the QR code through the Even Realities app's developer mode. The Vite server listens on the local network. A normal browser does not supply the Even SDK bridge; use the simulator or companion app for the full application.

In the app's **Settings**:

1. Set **Server WebSocket URL** to `ws://192.168.1.20:8000/asr`, using your computer's actual address. `localhost` on the phone refers to the phone, not the computer.
2. Choose **Transcript** for a captions server, or **Translation** for a server launched with `--direct-english-translation`.
3. Save. The visible status explains connection and setup errors.

The server controls source language, translation mode, model, and diarization. The phone settings also control sentence splitting, speaker labels, alignment, vertical anchor, line spacing, text width, and maximum lines. Speaker labels require diarization enabled on the server. Settings are stored per user through the Even SDK.

Optionally copy `.env.example` to `.env.local` and set `VITE_WHISPERLIVEKIT_URL` as the default endpoint. It is a client-visible URL, not a secret. An entered endpoint takes precedence.

## Network and privacy

The app sends microphone audio directly to the WhisperLiveKit endpoint you configure. Speech inference runs on that server. This client does not require an API key or add authentication to the connection.

Use `ws://` with an HTTP app on a trusted LAN. An app served over HTTPS requires a `wss://` endpoint with a trusted certificate. Keep the speech server on a private network; before exposing it externally, provide TLS and suitable access controls, such as a private network gateway. The development script listens on all network interfaces.

`app.json` contains microphone and network permissions and no Soniox domain. Allowed network hosts are deployment-specific; an Even Hub deployment may require you to whitelist the actual server host. Configure that for your deployment rather than assuming an arbitrary endpoint will be allowed.

## Verify

```sh
npm test
npm run build
npm run pack
```

The package is written to `whisperlivekit-translate.ehpk`. Build before packing. See [VERIFICATION.md](VERIFICATION.md) for measured results and the remaining hardware checks.

With the speech server running, this smoke test uses the **same WebSocket client as the app**, streams speech at real-time speed, and waits for the final server result:

```sh
# macOS: uses say to generate speech, then ffmpeg to convert it to PCM.
EXPECT_TEXT='quick brown fox' npm run smoke -- "The quick brown fox jumps over the lazy dog."

# Any platform with ffmpeg: use a recorded speech file.
AUDIO_FILE=/path/to/speech.wav npm run smoke

# Use a different server endpoint.
WHISPERLIVEKIT_URL=ws://192.168.1.20:8000/asr AUDIO_FILE=/path/to/speech.wav npm run smoke
```

`AUDIO_FILE` may be any speech file that your `ffmpeg` installation can decode. Without it, the script uses macOS `say`; `SAY_VOICE` selects a voice installed on that Mac. For example, after starting the Spanish-to-English server above:

```sh
SAY_VOICE='Mónica' EXPECT_TEXT='good morning' npm run smoke -- \
  "Hola, buenos días. Esta es una prueba de traducción. Muchas gracias."
```

For Russian-to-English translation, restart the server with:

```sh
npm run server -- --model base --lan ru --direct-english-translation
```

Then run the test with macOS's installed `Milena` voice:

```sh
SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

`EXPECT_TEXT` is an optional case-insensitive regular expression checked against the final text. The script fails on server errors, timeout, empty recognition, or a failed expected-text check. A passing smoke test verifies the speech path; it does not measure translation quality or prove the physical glasses connection.

The full application smoke test also runs `main.ts` and the real SDK event parser, feeds audio events into the app, and checks the phone text, glasses update calls, and foreground-exit shutdown. It uses jsdom and stubs the native microphone/glasses bridge, so it does not replace a hardware test:

```sh
# Run against the Russian-to-English server above.
OUTPUT_MODE=translation WHISPERLIVEKIT_URL=ws://127.0.0.1:8000/asr \
  SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke:app -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

## Implementation

```text
G2 microphone → Even SDK / phone WebView → WhisperLiveKit /asr WebSocket
                                                ↓
                     cumulative text snapshots + provisional text
                                                ↓
                           one glasses pane + phone text mirror
```

| File | Purpose |
|---|---|
| `src/asr/stt.ts` | WhisperLiveKit protocol, PCM streaming, snapshots, reconnect, backpressure, shutdown |
| `src/main.ts` | Even SDK lifecycle, glasses layout, text fitting, serialized display updates |
| `src/ui.ts`, `src/settings.ts` | Phone settings, endpoint validation, live text mirror |
| `scripts/start-server.sh` | Local server defaults |
| `scripts/whisperlivekit-smoke.ts` | Real speech test through the app's client |
| `scripts/browser-smoke.mjs` | Full application speech test with a stubbed native bridge |
| `tests/` | Protocol and UI regression checks |

Old screenshots in the repository are historical upstream assets; they do not represent this fork's interface or capabilities.

## Credits and license

Based on Intel Chen's [Soniox Translate](https://github.com/intelc/soniox-translate), with the original copyright and [MIT license](LICENSE) retained. Speech processing uses [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit). Glasses integration uses the Even Hub SDK; text measurement uses `@evenrealities/pretext`.

This project is not affiliated with or endorsed by Even Realities, Soniox, or the WhisperLiveKit maintainers.
