// Lightweight frontend logger
// In production, this could be wired to Sentry or similar
const isDev = import.meta.env.DEV;

const logger = {
  error: (msg, data) => {
    console.error(`[Florrie] ${msg}`, data || '');
    // TODO: Send to error tracking service (Sentry, LogRocket, etc.)
  },
  warn: (msg, data) => {
    if (isDev) console.warn(`[Florrie] ${msg}`, data || '');
  },
  info: (msg, data) => {
    if (isDev) console.info(`[Florrie] ${msg}`, data || '');
  },
  debug: (msg, data) => {
    if (isDev) console.debug(`[Florrie] ${msg}`, data || '');
  },
};

export default logger;
