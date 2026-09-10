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
        // HTML 仍纳入预缓存（供离线壳 + 消除 non-precached-url 报错）；导航走 NetworkFirst
        // （线上每次拉最新 HTML，断网才回退缓存），并保留 cleanup/clientsClaim/skipWaiting 自愈。
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: 'kchart.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          { urlPattern: ({ request }) => request.mode === 'navigate', handler: 'NetworkFirst', options: { cacheName: 'nav', networkTimeoutSeconds: 5 } }
        ]
      }
    })
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/llm-proxy': {
        target: 'http://127.0.0.1:3457',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm-proxy/, '')
      },
      '/rss-proxy': {
        target: 'https://www.coindesk.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rss-proxy/, '/arc/outboundfeeds/rss')
      }
    }
  },
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
