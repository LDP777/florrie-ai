import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';

// Custom plugin to force-clean dist before build
const cleanDistPlugin = {
  name: 'clean-dist',
  async buildStart() {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      try {
        // Try recursive removal with force flag
        fs.rmSync(distPath, { recursive: true, force: true });
        console.log('Cleaned dist directory');
      } catch (err) {
        console.warn('Warning: Could not clean dist directory:', err.message);
        // Continue anyway, Vite's emptyOutDir should still work
      }
    }
  },
};

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    // Raise the chunk-size warning ceiling now that we manually split heavy
    // libs into their own chunks. The biggest user-facing chunk is the React
    // app shell, sitting around 320 KB after splitting.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks: {
          // @sentry/react + Replay weighs ~150 KB on its own
          sentry: ['@sentry/react'],
          // PostHog ~70 KB
          posthog: ['posthog-js'],
          // xlsx parser ~120 KB, only loads on the migration page
          xlsx: ['xlsx'],
          // React + React-DOM + react-router-dom into a stable vendor chunk
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Supabase JS client ~80 KB
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  plugins: [
    cleanDistPlugin,
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'favicon-32.png',
        'favicon-192.png',
        'favicon-512.png',
        'favicon-maskable-512.png',
        'apple-touch-icon.png',
        'og-image.png',
      ],
      manifest: {
        name: 'florrie.ai, Your AI Beauty Business Team',
        short_name: 'florrie.ai',
        description: 'AI-powered beauty business management. Bookings, payments, messaging, content, all handled by your AI team.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FAF8F5',
        theme_color: '#FAF8F5',
        categories: ['business', 'productivity', 'lifestyle'],
        icons: [
          { src: '/favicon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/favicon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/favicon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        screenshots: [],
        shortcuts: [
          {
            name: 'Calendar',
            short_name: 'Calendar',
            url: '/calendar',
            icons: [{ src: '/favicon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Inbox',
            short_name: 'Inbox',
            url: '/inbox',
            icons: [{ src: '/favicon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Money',
            short_name: 'Money',
            url: '/money',
            icons: [{ src: '/favicon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        // Import push notification handler into generated service worker
        importScripts: ['/sw-push.js'],
        // Cache API responses for 5 minutes (stale-while-revalidate)
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'florrie-api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 5, // 5 minutes
              },
              networkTimeoutSeconds: 10,
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'florrie-images-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
            },
          },
        ],
        // Precache the app shell (exclude landing page, it's served separately)
        globPatterns: ['**/*.{js,css,ico,png,svg,woff2}', 'index.html'],
        globIgnores: ['landing.html', 'landing-v2.html'],
        // Don't intercept navigation to landing page
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/landing\.html$/, /^\/api\//, /^\/book\//],
        // Skip waiting so updates apply immediately
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
