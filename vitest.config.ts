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
    // (workers can exit 127 with no test failure). Threads keep `npm test`
    // deterministic; one worker also avoids jsdom test-file interference.
    pool: 'threads',
    maxWorkers: 1,
  },
})
