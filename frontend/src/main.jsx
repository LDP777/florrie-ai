import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './lib/theme.jsx';
import * as Sentry from '@sentry/react';
import App from './App.jsx';
import './index.css';

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
