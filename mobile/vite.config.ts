import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mobileDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(mobileDirectory, '../src/shared'),
      '@types': path.resolve(mobileDirectory, '../src/types'),
    },
  },
  server: {
    fs: { allow: [path.resolve(mobileDirectory, '..')] },
  },
})
