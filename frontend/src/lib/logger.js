// Lightweight frontend logger
// In production, this could be wired to Sentry or similar
const isDev = import.meta.env.DEV;

const logger = {
  error: (msg, data) => {
    console.error(`[florrie.ai] ${msg}`, data || '');
    // TODO: Send to error tracking service (Sentry, LogRocket, etc.)
  },
  warn: (msg, data) => {
    if (isDev) console.warn(`[florrie.ai] ${msg}`, data || '');
  },
  info: (msg, data) => {
    if (isDev) console.info(`[florrie.ai] ${msg}`, data || '');
  },
  debug: (msg, data) => {
    if (isDev) console.debug(`[florrie.ai] ${msg}`, data || '');
  },
};

export default logger;
