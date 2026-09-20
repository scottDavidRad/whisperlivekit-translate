# Store listing — Whisper Translate

Draft listing for the WhisperLiveKit fork. Physical G2 verification and deployment-specific network permissions remain required before release.

## Short description

Live captions and English speech translation on G2, using your own WhisperLiveKit server.

## Full description

Whisper Translate connects your Even Realities G2 microphone to a WhisperLiveKit server that you run. Read live captions in the spoken language, or start the server in native English translation mode to display English text.

The glasses show one text pane, with a matching live text display and connection status on your phone. Adjust text alignment, width, spacing, line count, sentence splitting, and vertical position. Speaker labels are available when the server provides diarization.

## Setup required

You need a computer running WhisperLiveKit, reachable from the phone. Enter its WebSocket address in the app's Settings. No Soniox account or API key is required.

The server chooses the model, source language, and speech task. To translate into English, start it with `--direct-english-translation` and select Translation in the app. That selector labels the output; it does not reconfigure the server. This version does not show the original and translation together or translate to arbitrary target languages.

Speech recognition, translation accuracy, and delay depend on the model, computer, and audio quality. Text may change as the model processes more speech.

## Privacy and network

Microphone audio is streamed to the WhisperLiveKit server address you configure for speech processing. Keep the server private or protect external access with TLS and appropriate access controls. HTTPS app hosting requires a secure `wss://` endpoint.

## Submission notes

- Configure any required Even Hub host allowlist for the actual server deployment. No Soniox domain is used.
- Replace historical upstream screenshots with screenshots of this fork before submission.
- See [VERIFICATION.md](../VERIFICATION.md) for software verification and remaining hardware checks.
- This fork is based on [Intel Chen's Soniox Translate](https://github.com/intelc/soniox-translate), with its MIT license and copyright retained.
