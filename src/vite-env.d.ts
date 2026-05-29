import type { ConvexReactClient } from "convex/react";

declare global {
  interface ImportMetaEnv {
    readonly VITE_CONVEX_URL: string;
    readonly VITE_CONVEX_SITE_URL?: string;
    readonly VITE_FEISHU_APP_ID?: string;
    readonly VITE_SENTRY_DSN?: string;
    readonly VITE_SENTRY_TUNNEL?: string;
    readonly VITE_CUSTOMER_SEARCH_MODE?: "preload" | "server-index";
  }

  interface Window {
    __convex?: ConvexReactClient;
  }
}
