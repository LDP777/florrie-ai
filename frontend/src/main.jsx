import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './lib/theme.jsx';
import * as Sentry from '@sentry/react';
import { initAnalytics } from './lib/analytics.js';
import App from './App.jsx';
import './index.css';

// Analytics + Sentry must never be able to blank the app on a bad init.
try {
  initAnalytics();
} catch (err) {
  console.error('[florrie] initAnalytics failed at startup:', err);
}

if (import.meta.env.VITE_SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.MODE,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
      ],
      tracesSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      replaysSessionSampleRate: 0.05,
      beforeSend(event, hint) {
        const error = hint?.originalException;
        const message = error?.message || event?.message || '';
        const name = error?.name || '';
        if (name === 'AbortError') return null;
        if (/Share canceled|Share cancelled|AbortError/i.test(message)) return null;
        if (/Script .*\/sw\.js.* load failed/i.test(message)) return null;
        if (/Maximum call stack size exceeded/i.test(message)) return null;
        if (/ResizeObserver loop|Loading chunk|Failed to fetch|NetworkError|Load failed/i.test(message)) return null;
        return event;
      },
    });
  } catch (err) {
    console.error('[florrie] Sentry init failed at startup:', err);
  }
}

// Native status bar: render as a solid bar (no overlay) so page content never
// sits under the clock / Dynamic Island and doesn't bleed under it on scroll.
// This also lifts the global "More" pill into the top-right corner instead of
// landing on the Today sub-tabs.
import('./lib/platform.js').then(({ isNativeApp }) => {
  if (!isNativeApp()) return;
  import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    StatusBar.setStyle({ style: Style.Light }).catch(() => {});
  }).catch(() => {});
}).catch(() => {});

const rootEl = document.getElementById('root');
try {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </StrictMode>
  );
} catch (err) {
  console.error('[florrie] Fatal render error:', err);
  if (rootEl) {
    rootEl.innerHTML =
      '<div style="padding:24px;font:13px/1.5 -apple-system,monospace;color:#900;white-space:pre-wrap;word-break:break-word"><b>App failed to start</b>\n\n' +
      ((err && (err.stack || err.message)) || String(err)) + '</div>';
  }
}
