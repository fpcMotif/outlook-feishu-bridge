/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

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
      include: ['src/**/*.{ts,tsx}', 'convex/**/*.ts'],
      // Excluded with justification (see ADR-0018). These are either
      // declarative (no executable branches worth a unit test), bootstrap
      // glue that only runs in a real host, type-only modules, or Convex
      // function wrappers whose only uncovered lines are ctx.run* calls that
      // need a live Convex runtime (we test their extracted pure logic
      // instead, matching the codebase's extract-then-test pattern).
      exclude: [
        '**/_generated/**',
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
        'convex/schema.ts', // declarative defineSchema/defineTable
        'convex/crons.ts', // declarative cron registration
        'convex/emails.ts', // internalMutation/query DB wrappers (no pure seam)
        'convex/returns.ts', // no live caller — deletion candidate (needs Convex schema change)
        'src/main.tsx', // bootstrap: createRoot + initDebug/initSentry
        'src/components/taskpane/requests.ts', // static REQUESTS data + type
        'src/components/taskpane/coworkers.ts', // type-only module
      ],
      // Lock in the ~99% achieved on the testable set (ADR-0018). Convex
      // ctx-action handlers are /* v8 ignore */-d with justification, so these
      // floors guard against real regressions, not framework glue. Branch is
      // a touch lower (cva variants, host-only Office branches).
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
})
