import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const localProxyBypass = "localhost,127.0.0.1,::1";
const chromeCanary = "/Applications/canary.app/Contents/MacOS/Google Chrome Canary";
const browserTarget = existsSync(chromeCanary)
  ? { launchOptions: { executablePath: chromeCanary } }
  : { channel: "msedge" };

process.env.NO_PROXY = process.env.NO_PROXY
  ? `${process.env.NO_PROXY},${localProxyBypass}`
  : localProxyBypass;
process.env.no_proxy = process.env.no_proxy
  ? `${process.env.no_proxy},${localProxyBypass}`
  : localProxyBypass;

export default defineConfig({
  testDir: "./e2e",
  reporter: "line",
  use: {
    ...browserTarget,
    baseURL: "https://127.0.0.1:3000",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command:
      "VITE_CONVEX_URL=https://joyful-capybara-123.convex.cloud bun run dev -- --host 127.0.0.1",
    ignoreHTTPSErrors: true,
    url: "https://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
