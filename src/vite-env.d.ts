/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIXED_TILED_SERVER?: string;
  readonly VITE_DOCS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
