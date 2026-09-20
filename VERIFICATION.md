# Verification

This record describes checks performed for the WhisperLiveKit-only fork on September 20, 2026. It distinguishes software and speech-server results from physical G2 behavior.

## Automated checks

`npm test` passed **19 tests**: 12 WebSocket-client tests and 7 phone-UI tests.

The client checks cover the raw PCM handshake, cumulative snapshot replacement, provisional text, pending diarization without duplicated words, speaker labels, rejected incompatible servers, reconnection, bounded audio queues, WebSocket backpressure, final result draining, abort behavior, and server/handshake errors.

The UI checks cover first-run setup, rejected invalid endpoints, normalized settings, an empty endpoint setup state, transcript/English translation labels, safe text rendering, and visible connection errors.

`npm audit` reported **zero vulnerabilities** after updating Vite to **7.3.6**. The repository CI workflow runs installation, tests, build, and packaging. Node.js **22.13 or newer** is required.

`npm run build` passed with TypeScript checking and Vite **7.3.6**. `npm run pack` passed and produced `whisperlivekit-translate.ehpk` (**71,879 bytes**, approximately 70 KB).

Full `main.ts` speech tests also passed for English captions and Russian-to-English translation, as detailed below.

## Real speech through the app's client

The smoke script used the actual `src/asr/stt.ts` client against a local WhisperLiveKit **0.2.19** server with raw PCM input, the `faster-whisper` backend, `localagreement` streaming, and multilingual Whisper models. Python **3.12** was used. The English and Spanish tests used **tiny**; the Russian test used **base**, which is the server script's default.

### English captions

Input speech:

> The quick brown fox jumps over the lazy dog.

Final text:

> the quick brown fox jumps over the lazy dog.

Result: passed; **41 snapshots**, including **22 with provisional text**. The server completed the utterance and acknowledged shutdown.

### Spanish speech translated into English

The server was configured with `--lan es --direct-english-translation`.

Input speech:

> Hola, buenos días. Esta es una prueba de traducción. Muchas gracias.

Final text:

> Hello, good morning. This is a test. proof. Thank you very much.

Result: the English translation path passed; **56 snapshots**, including **22 with provisional text**. The server completed the utterance and acknowledged shutdown. The extra “proof” and omitted translation wording are recognition/translation errors in this sample, so this is evidence that the translation path works, not a claim of accurate translation. Model choice and real-world audio can change both accuracy and latency.

### Russian speech translated into English

The server was configured with `--model base --lan ru --direct-english-translation` on local port `18767`. macOS `say` generated the input with the `Milena` voice.

Input speech:

> Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь.

Final text:

> Good morning! This is the test of Russian to English. Thank you for your help.

Result: passed; **88 snapshots**, including **42 with provisional text**. The final result matched `(?=.*good morning)(?=.*help)`. This demonstrates streaming Russian-to-English output with the default model; it does not establish accuracy across speakers or recordings.

## Full application speech tests

`npm run smoke:app` runs the actual `main.ts` application and Even SDK event parser with a real WhisperLiveKit server. A jsdom document supplies the phone UI. The native microphone/glasses bridge is stubbed: recorded PCM arrives as SDK audio events and display updates are captured as bridge calls. These are application integration tests, not physical-glasses tests.

### English captions through the application

Using the `tiny` model, the application processed **39 audio events** carrying **121,942 PCM bytes** and issued **12 `textContainerUpgrade` calls**.

Displayed text:

> The Quick Brown Fox jumps over the... the lazy dog.

The extra hesitation and repeated “the” differ from the input. This run verifies the complete software path despite those recognition errors.

### Russian-to-English through the application

Using the `base` model with `--lan ru --direct-english-translation`, the application processed **61 audio events** carrying **192,326 PCM bytes** and issued **9 `textContainerUpgrade` calls**.

Phone text:

> Good morning! This is the test of Russian translation. to English. Thank you for your help.

The captured glasses update contained the same text wrapped across **four lines**. Sentence boundaries were imperfect, but both the phone and glasses-update path received English translation.

A simulated foreground exit turned the microphone off, sent **one empty binary audio message**, and received **one `ready_to_stop` acknowledgment** from the real server. This verifies graceful application shutdown through the stubbed bridge and actual speech connection.

## Reproduce

Install the pinned requirements and start the server as described in [README.md](README.md). To use the model tested here, add `--model tiny`:

```sh
npm run server -- --model tiny --lan en
```

In another terminal on macOS, with `ffmpeg` available:

```sh
EXPECT_TEXT='quick brown fox' npm run smoke -- "The quick brown fox jumps over the lazy dog."
```

For translation, stop the captions server and run:

```sh
npm run server -- --model tiny --lan es --direct-english-translation
```

Then generate Spanish speech with an installed macOS voice, or provide a recording using `AUDIO_FILE`:

```sh
SAY_VOICE='Mónica' EXPECT_TEXT='good morning' npm run smoke -- \
  "Hola, buenos días. Esta es una prueba de traducción. Muchas gracias."
```

For the Russian case, restart the server with `npm run server -- --model base --lan ru --direct-english-translation`, then run:

```sh
SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

The commands use port 8000. If reproducing the original test's port 18767, add `--port 18767` to the server command and set `WHISPERLIVEKIT_URL=ws://127.0.0.1:18767/asr` for the smoke test.

To reproduce the full application Russian case against the same running server:

```sh
OUTPUT_MODE=translation WHISPERLIVEKIT_URL=ws://127.0.0.1:8000/asr \
  SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke:app -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

The smoke script requires a nonempty final result and orderly completion. `EXPECT_TEXT` adds a text assertion. Snapshot counts vary with timing; the counts above are observations, not test thresholds.

## Remaining limits

- **Physical G2 glasses were not tested.** Microphone capture, Bluetooth display updates, companion WebView networking, and device lifecycle behavior still need verification on real hardware.
- The speech tests used synthetic speech, not a noisy conversation. They are not an accuracy or latency benchmark.
- Live speaker diarization was not tested against a real multi-speaker recording; the client rendering behavior has protocol tests.
- Hosted deployments need their own TLS, access-control, and network-host permission checks. The local test does not establish that an externally hosted app can reach a private server.
- Native English translation returns one output stream. Bilingual output and arbitrary target languages are not supported by this fork.
