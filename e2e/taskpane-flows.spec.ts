// Additional browser-preview e2e journeys that complement taskpane-auth.spec.ts.
// These deliberately stop BEFORE the final "Sync" click: the dev/preview build
// talks to the real Convex deployment (main.tsx), and submitting would write a
// live Bitable row + fire a Self-Forward. So these specs exercise the login gate,
// the build-screen validation, and the coworker step's selection / switch / back
// navigation — all read-only — and leave the one submitting path to the existing
// happy-path spec.
import { expect, test, type Page } from "@playwright/test";

// Mock the Office host exactly like taskpane-auth.spec.ts: onReady fires with a
// browser (no mailbox) host, so the SPA falls into dev-preview mode.
async function installOfficeMock(page: Page) {
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
}

async function gotoTaskpane(page: Page) {
  await installOfficeMock(page);
  await page.goto("/");
  await expect(page).toHaveTitle("feishu-sync");
}

test("offers both the primary and backup login, and the backup advances to the builder", async ({ page }) => {
  await gotoTaskpane(page);

  await expect(page.getByRole("heading", { name: "Connect to Feishu" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole("button", { name: "Continue with Feishu" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Use backup login/i })).toBeVisible();
  // No request builder is reachable before sign-in.
  await expect(page.getByRole("button", { name: "Quotation" })).toHaveCount(0);

  // Dev preview treats the backup login as an instant sign-in too.
  await page.getByRole("button", { name: /Use backup login/i }).click();
  await expect(page.getByRole("heading", { name: "Connect to Feishu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quotation" })).toBeVisible();
});

test("the build step blocks Continue until a request note is filled", async ({ page }) => {
  await gotoTaskpane(page);
  await page.getByRole("button", { name: "Continue with Feishu" }).click();

  // Empty build screen: the dock shows the hint and is disabled.
  const emptyDock = page.getByRole("button", { name: /Start a request above/i });
  await expect(emptyDock).toBeVisible();
  await expect(emptyDock).toBeDisabled();

  // Filling a note enables Continue.
  await page.getByRole("button", { name: "Quotation" }).click();
  await page.getByRole("textbox", { name: /Describe your requirements/i }).fill("Need a quarterly L-Carnitine quote.");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();

  // Clearing it reverts to the disabled hint — the dock reacts to the note state.
  await page.getByRole("textbox", { name: /Describe your requirements/i }).fill("");
  await expect(page.getByRole("button", { name: /Start a request above/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
});

test("the coworker step requires exactly one pick, supports switching, and preserves the note on Back", async ({ page }) => {
  await gotoTaskpane(page);
  await page.getByRole("button", { name: "Continue with Feishu" }).click();

  await page.getByRole("button", { name: "Quotation" }).click();
  await page.getByRole("textbox", { name: /Describe your requirements/i }).fill("Need a quarterly L-Carnitine quote.");
  await page.getByRole("button", { name: "Continue" }).click();

  // Coworker step: nothing selected → the Sync dock is disabled.
  await expect(page.getByText("Client & coworker")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose exactly one Feishu coworker" })).toBeDisabled();

  // Selecting one enables the sync dock; switching replaces the selection.
  await page.getByRole("button", { name: /Jenny Xu/ }).click();
  await expect(page.getByRole("button", { name: "Sync with Jenny Xu" })).toBeEnabled();
  await page.getByRole("button", { name: /Michael Chen/ }).click();
  await expect(page.getByRole("button", { name: "Sync with Michael Chen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync with Jenny Xu" })).toHaveCount(0);

  // Back returns to the build screen with the request preserved — the dock still
  // offers an enabled "Continue" because the filled-request count is non-zero.
  await page.getByRole("button", { name: /^Back$/ }).click();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
});
