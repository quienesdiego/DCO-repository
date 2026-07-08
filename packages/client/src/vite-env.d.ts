/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DCO_API_URL?: string;
  readonly VITE_DCO_API_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
