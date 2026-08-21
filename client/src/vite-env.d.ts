/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The API's origin when it is served from its own domain, e.g. https://api.example.com.
   * Host only — the '/api' prefix is added by the client. Unset in development, where the
   * app calls '/api' same-origin and Vite proxies it to the local server.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
