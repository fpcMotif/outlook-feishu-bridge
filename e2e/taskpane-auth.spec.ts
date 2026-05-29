import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

async function screenshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({ path: path.join(dir, name), fullPage: false });
}

test("browser preview keeps login separate and shows merged request routing", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" &&
      !text.startsWith("Failed to load resource:") &&
      !text.includes("ERR_NETWORK_CHANGED")
    ) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    window.Office = {
      onReady: (callback: (info: { host: null; platform: string }) => void) => {
        window.setTimeout(() => callback({ host: null, platform: "browser" }), 0);
      },
      context: {
        mailbox: null,
        requirements: { isSetSupported: () => false },
      },
    };
  });

  await page.goto("/?e2eCoworkers=1");
  await expect(page).toHaveTitle("feishu-sync");
  await expect(page.getByRole("heading", { name: "Connect to Feishu" })).toBeVisible({
    timeout: 12_000,
  });
  await expect(page.getByRole("button", { name: "Quotation" })).toHaveCount(0);
  await screenshot(page, "outlook-sales-login.png");

  await page.getByRole("button", { name: "Continue with Feishu" }).click();

  await expect(page.getByRole("heading", { name: "Connect to Feishu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quotation" })).toBeVisible();
  await expect(page.getByText("Email")).toBeVisible();
  await expect(page.getByText("Search by name to choose a Feishu coworker")).toHaveCount(0);
  await expect(page.getByText(/Recent & suggested/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start a request above" })).toBeDisabled();

  await page.getByRole("button", { name: "Quotation" }).click();
  await page.getByPlaceholder(/Describe your requirements/i).fill("Need a quarterly L-Carnitine quote.");
  await expect(page.getByRole("button", { name: "Choose exactly one Feishu coworker" })).toBeDisabled();
  await expect(page.locator(":root")).toHaveCSS("--primary", "oklch(0.532 0.148 251.075)");
  await screenshot(page, "outlook-sales-builder.png");

  await page.getByLabel("Search Feishu coworkers").fill("Jenny");
  await page.getByRole("button", { name: /^Jenny Xu/ }).click();
  await expect(page.getByRole("button", { name: "Sync with Jenny Xu" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Connect to Feishu" })).toHaveCount(0);
  await screenshot(page, "outlook-sales-merged-routing.png");
  expect(consoleErrors).toEqual([]);
});
