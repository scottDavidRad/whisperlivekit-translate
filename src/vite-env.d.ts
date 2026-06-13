/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Dev-only Soniox API key. Used ONLY in `npm run dev` (import.meta.env.DEV)
   * as a convenience so the simulator works without typing a key. Production
   * builds ignore it — each user enters their own key in the app's Settings.
   * All other behavior (target language, sentence splitting, speaker labels,
   * keep-as-is languages) is configured in-app via Settings, not env vars.
   */
  readonly VITE_STT_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
