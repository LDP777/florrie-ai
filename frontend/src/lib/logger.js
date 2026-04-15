// Lightweight frontend logger
// In production, this could be wired to Sentry or similar
const isDev = import.meta.env.DEV;

const logger = {
  error: (msg, data) => {
    logger.error(`[florrie.ai] ${msg}`, data || '');
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
