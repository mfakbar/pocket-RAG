import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },

  preload: {
    plugins: [externalizeDepsPlugin()]
  },

  renderer: {
    publicDir: resolve('docs'),
    plugins: [react(), tailwindcss()],

    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
