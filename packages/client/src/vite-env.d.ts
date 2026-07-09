/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Read directly by DCOView.tsx — same env var name as the source MUSE frontend. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
