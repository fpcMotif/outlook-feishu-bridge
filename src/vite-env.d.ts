/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_CONVEX_SITE_URL?: string;
  readonly VITE_FEISHU_APP_ID?: string;
  readonly VITE_CUSTOMER_SEARCH_MODE?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_TUNNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __convex?: unknown;
}
