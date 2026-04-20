import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './lib/theme.jsx';
import * as Sentry from '@sentry/react';
import { initAnalytics } from './lib/analytics.js';
import App from './App.jsx';
import './index.css';

initAnalytics();

// Initialise Sentry. No-op when VITE_SENTRY_DSN is absent (local dev / staging
// without a DSN configured).
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Replay captures a session recording on every error — invaluable for
      // "I don't know how to reproduce this" support tickets.
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,  // always replay on error
    replaysSessionSampleRate: 0.05, // 5% of normal sessions
    // Filter out noise — user-cancelled share dialogs, stale bundles, network blips.
    beforeSend(event, hint) {
      const error = hint?.originalException;
      const message = error?.message || event?.message || '';
      const name = error?.name || '';

      // User-cancelled share dialogs (Safari iOS may throw plain Error, not DOMException)
      if (name === 'AbortError') return null;
      if (/Share canceled|Share cancelled|AbortError/i.test(message)) return null;

      // Stale service worker from previous deploys trying to load a removed /sw.js
      if (/Script .*\/sw\.js.* load failed/i.test(message)) return null;

      // Stale deployed bundle — older builds had a logger-recursion bug (logger.error
      // calling itself), which throws RangeError in a loop. Source has been fixed; the
      // errors come from cached bundles on users' devices and clear on next hard reload.
      if (/Maximum call stack size exceeded/i.test(message)) return null;

      // Browser extensions and transient network
      if (/ResizeObserver loop|Loading chunk|Failed to fetch|NetworkError|Load failed/i.test(message)) return null;

      return event;
    },
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
