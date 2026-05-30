import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import * as Sentry from "@sentry/react";
import App from "./App";
import { initDebug } from "./debug";
import { initSentry } from "./sentry";
import { mountDevDarkToggle } from "./devDarkToggle";
import "./index.css";

initDebug();
initSentry();

if (import.meta.env.DEV) mountDevDarkToggle();

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
// Expose the Convex client on window so the DebugPanel can show WebSocket
// state; the leading underscores are Convex's contract for this attachment.
// eslint-disable-next-line no-underscore-dangle
window.__convex = convex;

const root = document.querySelector("#root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={<p className="text-destructive p-4 text-sm">Something went wrong - reload the add-in.</p>}
    >
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
