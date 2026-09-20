# Verification

This record describes checks performed for the WhisperLiveKit-only fork on September 20, 2026. It distinguishes native desktop simulator, software integration, speech-server, and physical G2 verification.

## Current interface and Conversate checks

The phone interface was updated from the official Translate and Conversate references. It is an independent Even Hub app using SDK text containers; it does not replace the operating system's built-in applications.

- **55 client tests and 27 Python tests passed locally.** The CI backend suite skips three checks that require the full local speech runtime. TypeScript checking, the Vite production build, and packaging passed after expanding the caption area. The package with the private endpoint preset was **79,811 bytes**; the generic CI build leaves the endpoint unset.
- **16 UI tests passed**, including Auto/manual source selection, real session callbacks, safe rendered speech and AI text, all four provider choices, Prep notes length limits, caption retention choices, cue preferences, and summary/action-item display.
- **Eight full-application scenarios passed** (nine Node test results including the enclosing test). These run the actual `main.ts` and SDK event parser in jsdom with fake speech/provider transports. They verify eight native-font caption lines in Translate, five in Conversate with a separate three-line AI cue area, no container overlap, and correct capacity after a mode change. They also cover microphone gating on task acknowledgment, exact audio forwarding, timed caption clearing, retained captions, Pause clearing with phone text retained, manual-language rejection/acknowledgment, per-session translate/transcribe mode, stale speech during delayed layout rebuild, stale AI response cancellation, double-tap ending with final speech drained before summary, and cleanup on page unload. They also verify history retained after background/resume with new anonymous speaker numbering, display-only settings after End, and summaries waiting for both late AI configuration and final speech acknowledgment.
- **Six conversation-client tests passed**, including an automatic retry of the same speech after Pause aborts a cue and Resume restarts assistance.
- **18 conversation and speech-adapter tests passed** with mocked provider responses and adapter checks. They cover request/response behavior, failures, timeouts, input limits, output validation, credential handling, and MLX task/context forwarding. The provider tests are distinct from the live Codex result below.
- Translate and Conversate were rendered and visually inspected in Chromium at **320, 375, 414, and 768 pixels** wide, with no horizontal overflow. The settings panel was also inspected at 320 pixels and its caption-retention/provider controls exercised. These screenshots use explicit test fixtures, not real speech or AI evidence.

Conversate uses `task=transcribe`, while Translate uses `task=translate` by default. Auto remains the default source; optional manual language choices use a per-connection request and require matching server acknowledgment. The new settings include Codex, Grok, Qwen 3.8, and OpenAI-compatible providers; availability depends on backend configuration. No credential input appears in the phone UI.

Captions default to clearing after five seconds without a changed caption. Three, ten, and fifteen seconds are also available, plus zero/Stay until replaced. Pause clears the glasses immediately in either mode, while the phone retains the current session text. AI cue duration is separate.

The current checks include the final session-lifecycle regressions. Earlier speech results below remain useful baselines. Physical G2 hardware remains untested.

## Final native simulator and complete Conversate checks

The official native Even Hub simulator ran against the Mac mini's private secure MLX endpoint. Russian speech from the macOS Milena voice was played aloud into the real Mac microphone. The actual application window was visually inspected on September 20, 2026. Before the later expansion to eight caption lines, its lower lens area displayed **AUTO → EN** and:

> Speaker 1: I live in Moscow. Thank you for your help.

The phone also displayed the earlier translated phrase “this is a test of translation from Russian to English. I live in Moscow.” The caption timer subsequently cleared the lens while preserving the phone text. The inspected native window rendered green text on black; a separate simulator image-export response was solid green and was not counted as display evidence. The native simulator remained open and listening after the check.

A separate native microphone test played Daniel → Samantha → Daniel speech. The phone showed Speaker 1 for the first voice and Speaker 2 for the second. An identical repeated third turn was absent from the transcript; a new sentence spoken by Daniel then correctly returned to **Speaker 1**, demonstrating **1 → 2 → 1** in the native path. The transition phrase “That sounds good” was assigned to the preceding voice, and an isolated “Thank you” remained unlabeled. This verifies distinct and returning voices in this recording without claiming perfect recognition or attribution.

The expanded build was then inspected in the native simulator: the header appeared at the top with **six readable caption lines visible at once**, green on black, without clipping. Automated rendering tests separately verify the full eight-line capacity. A new **29.32-second** recording with distinct Daniel → Samantha → Daniel turns again showed **1 → 2 → 1** on the phone. The first two turns were largely accurate, but the final turn was incorrectly recognized as “one one one one notification Thank you for watching!” This confirms the expanded display and returning-speaker path, not clean acoustic transcription.

A separate `smoke:app` test ran the actual `main.ts` and SDK event parser against **both the real Mac mini speech server and real Codex assistance**. It processed **16.0 seconds of audio through 160 SDK audio events**, produced one speaker label, and issued **16 glasses updates**. A real AI cue appeared in the phone and upper lens container. After End drained the final speech, the summary correctly reflected Sam's Thursday commitment and the Friday release.

That combined Conversate test used a stubbed native microphone/glasses bridge and jsdom; its speech server and AI provider were real. The native microphone/display check above was a separate Russian Translate session. Neither is a physical G2 hardware test.

## Live Codex assistance

The Mac mini's existing authenticated Codex CLI produced a real Conversate cue and summary with **gpt-5.5** and low reasoning. The cue completed in **3.38 seconds** and the summary in **3.69 seconds**. Both used synthetic meeting context; these timings measure the provider calls, not speech recognition plus AI end-to-end latency. Codex used the saved ChatGPT login without an API key in the app.

The same assistance was also exercised through the deployed private HTTPS routes: the cue returned HTTP 200 in **3.59 seconds** and the summary in **3.31 seconds**. A synthetic filesystem canary was unavailable to the assistant and was not disclosed.

Grok, Qwen 3.8, and generic OpenAI-compatible request/response handling are covered by mocked tests. Their cloud credentials were absent from this test deployment, so no successful live request to those providers is claimed.

## Apple silicon MLX speech checks

The MLX adapter was tested locally with the multilingual small model and Sortformer diarization. It correctly returned original Russian captions, Russian-to-English translation, a Russian → Spanish recording translated into English in one connection, and two voices labeled **1 → 2 → 1**. Disabling previous-text conditioning removed repeated clauses in the two-voice result.

| Recording | Audio sent, including two seconds of silence | Completion including final drain |
|---|---:|---:|
| Russian | 8.37 s | 8.6 s |
| Russian → Spanish | 16.22 s | 16.6 s |
| Two alternating voices | 27.66 s | 28.1 s |

A standalone Spanish test contained one duplicate “test”; the mixed-language Spanish passage translated correctly. These are successful recorded-speech checks, not an accuracy guarantee.

## Mac mini private speech backend: MLX GPU

The final deployment uses an **Apple M4 Mac mini with 16 GB RAM**, MLX float16 small-model inference, automatic source selection, English translation, and Sortformer diarization. It uses one decoding beam and one-second speech chunks. A dedicated inference thread fixed an MLX thread-affinity crash; the following rerun began cold, without a warm-up recording.

All four recordings passed through the private secure endpoint and received `ready_to_stop`. English output was correct for these recordings, and the alternating voices retained labels **1 → 2 → 1**.

| Recording | Audio sent, including two seconds of silence | First caption | Completion including final drain |
|---|---:|---:|---:|
| Russian, cold start | 8.37 s | 4.92 s | 10.03 s |
| Spanish | 7.85 s | 1.61 s | 8.93 s |
| Russian → Spanish | 16.22 s | 1.71 s | 18.56 s |
| Two alternating voices | 27.66 s | 1.59 s | 29.08 s |

The two-voice recording improved from **48.81 seconds on CPU to 29.08 seconds on GPU**. These measured recordings finished close to playback time after warming up. Longer conversations, concurrent clients, overlapping speech, and other models can behave differently; the result does not establish universal real-time performance or perfect recognition.

## Mac mini private speech backend: CPU baseline

The server was deployed to an **Apple M4 Mac mini with 16 GB RAM**, running the multilingual small model with automatic source selection, English translation, and Sortformer diarization. A per-user launchd service starts it, and private TLS access forwards to a loopback listener. The deployment did not publish a public tunnel or replace existing private gateway configuration.

Four real recordings passed through the private secure endpoint: Russian, Spanish, Russian → Spanish in one connection, and two voices alternating **1 → 2 → 1**. First captions arrived after roughly **3.3–3.7 seconds**.

| Recording | Audio sent, including two seconds of silence | Completion including final drain |
|---|---:|---:|
| Russian | 8.37 s | 14.11 s |
| Spanish | 7.85 s | 14.26 s |
| Russian → Spanish | 16.22 s | 22.03 s |
| Two alternating voices | 27.66 s | 48.81 s |

The longer CPU test lagged substantially. These figures are not a claim of consistently real-time performance. The validated GPU results above are recorded separately rather than replacing this baseline.

The native simulator was also connected to the private speech service and its live interface inspected. Physical G2 hardware remains untested.

## Version 0.3: automatic source language and speaker labels

The server was started with Python **3.12.13**, WhisperLiveKit **0.2.19**, faster-whisper **1.2.1**, CTranslate2 **4.8.2**, and NeMo ASR **3.0.0**:

```sh
.venv/bin/wlk --host 127.0.0.1 --port 18768 --pcm-input \
  --backend faster-whisper --backend-policy localagreement --model base \
  --lan auto --direct-english-translation \
  --diarization --diarization-backend sortformer
```

The public `nvidia/diar_streaming_sortformer_4spk-v2` model loaded successfully and ran on CPU. Its capacity is up to four voices per connection.

### Automatic source-language tests

Russian and Spanish speech were sent in separate connections to the **same unchanged server configured with `--lan auto`**. No source language was supplied by the client.

Russian final output:

> Good morning! This is a check from Russian to English, I live in Moscow, thank you for your help.

Spanish final output:

> Hello, good morning, this is a translation test, I live in Madrid, muchas gracias por su ayuda.

Both runs produced speaker ID 1 and received `ready_to_stop`. The Russian run contained 90 server responses; the Spanish run contained 82. The Spanish closing phrase remained in Spanish, demonstrating an accuracy limitation even though English translation mode was enabled. These runs verify automatic source selection for these two examples, not every supported language or reliable language switching inside one stream. The server does not return its detected language code to the app.

### Default model changed to small

The tests were repeated on port 18769 with the same automatic-language, translation, and Sortformer settings, replacing `--model base` with `--model small`. The `small` model translated the previously untranslated Spanish closing phrase, so it is now the launcher's default.

Russian final output:

> Good morning! This is a test of translation from Russian to English. I live in Moscow. Thank you for your help!

Spanish final output:

> Hello, good morning, this is a translation test, I live in Madrid, thank you very much for your help.

A recording switching from Russian to Spanish within **one WebSocket connection** also produced complete English output without a source-language configuration change. Speaker attribution fluctuated during the Spanish portion, so the language-switch result does not establish reliable speaker attribution during a language switch.

These CPU tests took about **10.7 seconds** to stream and finalize Russian speech lasting **6.37 seconds**, **10.7 seconds** for Spanish speech lasting **5.85 seconds**, and **17.8 seconds** for the mixed recording lasting **14.2 seconds**. The test adds two seconds of silence. These totals include playback, silence, and finalization; they are not measurements of per-word latency. The observed server resident memory was approximately **2.5 GB**, with about **911 MB** of model downloads in this setup.

### Multiple voices

A synthetic English recording alternated macOS voices **Daniel → Samantha → Daniel**. Sortformer returned speaker IDs **1 → 2 → 1**, correctly reusing the first voice's ID when it returned. The run contained 266 server responses and received `ready_to_stop`.

One short “Good morning” at a speaker transition was assigned to the preceding voice. Speaker labels are anonymous, provisional voice distinctions, not a guarantee of correct attribution or personal identity. Real conversations, overlapping speakers, and identities across connections remain unverified.

The same Daniel → Samantha → Daniel recording was then repeated with the default **small** model. It again returned **1 → 2 → 1**, with the complete text and correctly separated turns; the base model's transition error was absent. This run contained **318 server responses**, received `ready_to_stop`, and completed in about **31.0 seconds** for **25.66 seconds** of speech plus two seconds of added silence. This is a successful synthetic two-voice test, not a general diarization accuracy claim.

### Native Even Hub simulator

The official native Even Hub simulator was launched on macOS with the app and microphone input enabled. Russian speech generated with the `Milena` voice was played into the microphone path:

> Доброе утро. Меня зовут Анна. Я живу в Москве. Спасибо за помощь.

With the earlier `base --lan ru --direct-english-translation` server on port 18767, the visible phone output included:

> I live in Moscow. Thank you for your help.

The introduction was mistranslated, and an unrelated ambient utterance was also captured. The native simulator screen was inspected. This confirms live microphone audio reaching the app and visible English output in the native simulator; it is not evidence of accurate translation for the whole utterance or a physical G2 test. Later private-backend tests are described above.

`npm test` passed **25 tests**: 18 protocol tests and 7 UI tests. `npm run build` and `npm run pack` passed; the version 0.3 package was **72,255 bytes**. The added protocol checks cover readable stable speaker labels, pending attribution, and reconnect behavior.

## Earlier version 0.2 verification

The following results predate the default automatic-language translation and speaker-diarization configuration.

### Automated checks

`npm test` passed **19 tests**: 12 WebSocket-client tests and 7 phone-UI tests.

The client checks cover the raw PCM handshake, cumulative snapshot replacement, provisional text, pending diarization without duplicated words, speaker labels, rejected incompatible servers, reconnection, bounded audio queues, WebSocket backpressure, final result draining, abort behavior, and server/handshake errors.

The UI checks cover first-run setup, rejected invalid endpoints, normalized settings, an empty endpoint setup state, transcript/English translation labels, safe text rendering, and visible connection errors.

`npm audit` reported **zero vulnerabilities** after updating Vite to **7.3.6**. The repository CI workflow runs installation, tests, build, and packaging. The tests ran with Node.js **26.5.0**. Dependency-compatible runtimes are Node.js **22.22.2+ within 22.x**, **24.15+ within 24.x**, or **26+**.

`npm run build` passed with TypeScript checking and Vite **7.3.6**. `npm run pack` passed and produced `whisperlivekit-translate.ehpk` (**71,879 bytes**, approximately 70 KB).

Full `main.ts` speech tests also passed for English captions and Russian-to-English translation, as detailed below.

### Real speech through the app's client

The smoke script used the actual `src/asr/stt.ts` client against a local WhisperLiveKit **0.2.19** server with raw PCM input, the `faster-whisper` backend, `localagreement` streaming, and multilingual Whisper models. Python **3.12** was used. The English and Spanish tests used **tiny**; the Russian test used **base**, which was the server script's default at that time.

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

Result: passed; **88 snapshots**, including **42 with provisional text**. The final result matched `(?=.*good morning)(?=.*help)`. This demonstrates streaming Russian-to-English output with the then-default model; it does not establish accuracy across speakers or recordings.

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
WLK_TASK=transcribe WLK_DIARIZATION=0 npm run server -- --model tiny --lan en
```

In another terminal on macOS, with `ffmpeg` available:

```sh
EXPECT_TEXT='quick brown fox' npm run smoke -- "The quick brown fox jumps over the lazy dog."
```

For translation, stop the captions server and run:

```sh
WLK_DIARIZATION=0 npm run server -- --model tiny --lan es
```

Then generate Spanish speech with an installed macOS voice, or provide a recording using `AUDIO_FILE`:

```sh
SAY_VOICE='Mónica' EXPECT_TEXT='good morning' npm run smoke -- \
  "Hola, buenos días. Esta es una prueba de traducción. Muchas gracias."
```

For the Russian case, restart the server with `WLK_DIARIZATION=0 npm run server -- --model base --lan ru`, then run:

```sh
SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

The commands use port 8000. If reproducing the original test's port 18767, add `--port 18767` to the server command and set `WHISPERLIVEKIT_URL=ws://127.0.0.1:18767/asr` for the smoke test.

To reproduce the full application Russian case against the same running server:

```sh
SOURCE_LANGUAGE=ru OUTPUT_MODE=translation WHISPERLIVEKIT_URL=ws://127.0.0.1:8000/asr \
  SAY_VOICE=Milena EXPECT_TEXT='(?=.*good morning)(?=.*help)' npm run smoke:app -- \
  "Доброе утро. Это проверка перевода с русского на английский. Спасибо за помощь."
```

The smoke script requires a nonempty final result and orderly completion. `EXPECT_TEXT` adds a text assertion. Snapshot counts vary with timing; the counts above are observations, not test thresholds.

## Remaining limits

- **Physical G2 glasses were not tested.** Microphone capture, Bluetooth display updates, companion WebView networking, and device lifecycle behavior still need verification on real hardware.
- The direct speech tests used synthetic speech. Their measured timings apply to those recordings and configurations; they are not a general performance or accuracy benchmark. The native simulator also picked up ambient audio.
- Speaker diarization was tested with two synthetic voices alternating in one recording, not a natural conversation or overlapping speakers. The base-model test misassigned one transition; the small-model repeat separated those turns correctly, while a mixed-language test still showed unstable attribution.
- Hosted deployments need their own TLS, access-control, and network-host permission checks. The local test does not establish that an externally hosted app can reach a private server.
- Native English translation returns one output stream. Bilingual output and arbitrary target languages are not supported by this fork.
