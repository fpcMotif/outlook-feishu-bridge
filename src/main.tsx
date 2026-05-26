import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import * as Sentry from "@sentry/react";
import App from "./App";
import { initDebug } from "./debug";
import { initSentry } from "./sentry";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./index.css";

initDebug();
initSentry();

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
(window as unknown as { __convex?: unknown }).__convex = convex;

const root = document.querySelector("#root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={<p className="p-4 text-red-600 text-sm">Something went wrong — reload the add-in.</p>}
    >
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
