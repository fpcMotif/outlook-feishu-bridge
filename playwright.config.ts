import { defineConfig } from "@playwright/test";

const localProxyBypass = "localhost,127.0.0.1,::1";
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
    baseURL: "http://localhost:3000",
    channel: "msedge",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
