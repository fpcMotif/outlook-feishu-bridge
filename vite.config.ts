import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === 'outlook' ? [basicSsl()] : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    rolldownOptions: {
      output: {
        // Split heavy vendors into their own chunks so no single chunk trips
        // Rolldown's 500 kB warning and browsers can cache them independently of
        // app code. Order matters: specific groups before the catch-all.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (id.includes('@sentry')) return 'sentry'
          if (id.includes('convex')) return 'convex'
          if (id.includes('turndown')) return 'turndown'
          return 'vendor'
        },
      },
    },
  },
}))
