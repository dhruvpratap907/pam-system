import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Rust Gateway
      '/session': { target: 'http://127.0.0.1:8443', changeOrigin: true },
      
      // Go Policy Engine (Backend)
      '/login': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/request_access': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/check_status': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/employee': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/audit': { target: 'http://127.0.0.1:9090', changeOrigin: true }
    }
  }
})