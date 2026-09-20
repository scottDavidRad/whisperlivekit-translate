/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default WhisperLiveKit /asr WebSocket URL for local development. */
  readonly VITE_WHISPERLIVEKIT_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
