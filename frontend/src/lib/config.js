/**
 * App-wide config — single source of truth for env-driven values.
 * If VITE_API_URL is missing in production, we throw at import time
 * so the problem is obvious immediately.
 */
import logger from './logger.js';

const isProd = import.meta.env.PROD;

export const API_BASE = import.meta.env.VITE_API_URL
  || (isProd ? '' : 'http://localhost:3001');

if (isProd && !import.meta.env.VITE_API_URL) {
  logger.error('FATAL: VITE_API_URL is not set in production build');
}
