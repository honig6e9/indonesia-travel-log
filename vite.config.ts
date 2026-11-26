import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages などサブパスに置く場合は VITE_BASE=/リポジトリ名/ を指定する
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Indonesia Travel Log',
        short_name: '旅ログ',
        description: 'インドネシア滞在の音声日記・リスト・記録',
        lang: 'ja',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#fbf8f3',
        theme_color: '#b5462f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android の共有メニューに出す。受け取りは public/share-target.js（Service Worker）
        share_target: {
          action: base + 'share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'files', accept: ['image/*'] }],
          },
        },
      },
      workbox: {
        // アプリシェルだけをキャッシュする。旅行データ（IndexedDB）や Supabase への通信は扱わない
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/auth\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // 共有の受け取りを Workbox より先に登録する
        importScripts: ['share-target.js'],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    testTimeout: 60000,
  },
});
