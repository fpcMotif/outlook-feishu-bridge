/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// ADR-0019: keep the hard 100% gate on extracted/tested logic seams.
// Declarative framework glue stays outside the denominator until its logic is
// extracted into one of these directly tested modules.
const LOGIC_COVERAGE_INCLUDE = [
  'convex/emailRecord.ts',
  'convex/feishu/contactsMirrorRows.ts',
  'src/components/ThemeToggle.tsx',
  'src/components/taskpane/attachmentFileDisplay.ts',
  'src/components/taskpane/attachmentSelection.ts',
  'src/components/taskpane/AuthResolvingScreen.tsx',
  'src/components/taskpane/buildCreateCustomerTaskUrl.ts',
  'src/components/taskpane/ConnectCard.tsx',
  'src/components/taskpane/customerSearchHelpers.ts',
  'src/components/taskpane/LoginScreen.tsx',
  'src/components/taskpane/NewRequestSection.tsx',
  'src/components/taskpane/RequestIntakeScaffold.tsx',
  'src/components/taskpane/RequestIntakeScreen.tsx',
  'src/components/taskpane/RequestIntakeSyncBridge.tsx',
  'src/components/taskpane/requests.ts',
  'src/components/taskpane/SectionLabel.tsx',
  'src/components/taskpane/submitSyncGate.ts',
  'src/components/taskpane/SyncErrorScreen.tsx',
  'src/components/taskpane/taskpaneOutsideDismiss.ts',
  'src/components/taskpane/taskpaneSearchPanelLayout.ts',
  'src/components/taskpane/useCustomerSearchSession.ts',
  'src/hooks/useAttachmentStaging.ts',
  'src/lib/utils.ts',
  'src/office/attachments.ts',
  'src/office/mailBody.ts',
] as const

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'e2e/**', '.claude/**'],
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    // Node 25 + Vitest's default fork pool is flaky on this Windows setup
    // (workers can exit 127 with no test failure). Threads keep `bun run test`
    // deterministic; one worker also avoids jsdom test-file interference.
    pool: 'threads',
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: [...LOGIC_COVERAGE_INCLUDE],
      exclude: [...(configDefaults.coverage.exclude ?? [])],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
})
