import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      devOptions: { enabled: false, type: 'module' },
      manifest: {
        id: '/kchart.html',
        name: 'K线多周期 SRSI 分析',
        short_name: 'K线SRSI',
        description: '多周期 SRSI + 交易纪律分析（独立 PWA）',
        theme_color: '#0a0e17',
        background_color: '#0a0e17',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        start_url: './kchart.html',
        scope: './',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: 'kchart.html'
      }
    })
  ],
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        kchart: 'kchart.html'
      }
    }
  }
});
