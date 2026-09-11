/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIXED_TILED_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
