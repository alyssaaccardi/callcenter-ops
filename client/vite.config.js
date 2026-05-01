import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/dialed-in': 'http://localhost:3001',
    }
  },
  build: { outDir: '../public/app' }
})
