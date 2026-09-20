# Store listing — Whisper Translate

Draft listing for this independent WhisperLiveKit application. Verify physical G2 behavior and deployment-specific networking before release.

## Short description

Automatic English translation, live captions, speaker labels, and optional AI conversation assistance on G2.

## Full description

Open the configured app and speak. Translate automatically recognizes supported speech languages and displays English translation. Choose a source language manually only if you want to; Auto remains the default.

Conversate keeps captions in the spoken language and adds AI cues, optional Prep notes, and an AI summary with action items after you end the session. Choose a configured backend provider: Codex, Grok, Qwen 3.8, or an OpenAI-compatible service.

The phone follows the familiar Translate and Conversate layout, with source-language controls, session text, settings, and Pause/End buttons. At the native font size, Translate fits eight caption lines; Conversate fits five caption lines and a separate three-line AI cue. Anonymous Speaker 1 / Speaker 2 labels distinguish voices when server diarization is enabled.

Captions can clear after 3, 5, 10, or 15 seconds, or stay until replaced. Pause immediately clears the glasses and stops the microphone while retaining text in the phone's current session. End or a double-tap on the temple finishes the session and its Conversate summary. AI cues have separate display timing and an optional automatic pop-up.

## Setup and limits

The operator provides a reachable WhisperLiveKit server and configures its address in the app once. AI provider authentication is configured only on the backend. A configured installation does not require setup input from the person wearing the glasses.

English is the translation target; simultaneous original/translated streams and reverse translation are not provided. Source-language support depends on the multilingual Whisper model. The default Sortformer model supports up to four anonymous voices per connection. It does not identify people by name.

Recognition, translation, speaker attribution, and AI assistance can be imperfect. Performance depends on the server and recording; some devices or long conversations can lag. This fork does not integrate with native Even account history.

## Privacy

Audio is processed by the configured WhisperLiveKit server. Conversate sends transcript context and optional Prep notes through that backend to the selected AI provider. Provider credentials stay on the backend. Use private networking and appropriate TLS/access controls.

## Submission notes

- Configure required host permissions for the deployed server. No Soniox service is used.
- Replace historical upstream screenshots with current screenshots before submission.
- Native simulator translation and the complete Conversate speech/AI software path were verified; physical G2 hardware remains untested.
- See [VERIFICATION.md](../VERIFICATION.md) for tests, measured results, and unverified hardware/provider limits.
- Based on [Intel Chen's Soniox Translate](https://github.com/intelc/soniox-translate), with its MIT license and copyright retained.
