/**
 * Shared query patterns and utilities for Supabase operations
 */
import logger from './logger.js';

/**
 * Parse pagination params from request
 * @param {{page?: string|number, per_page?: string|number}} query - Express query object
 * @returns {{page: number, per_page: number, offset: number}} Pagination params
 */
export function parsePagination(query, defaultPerPage = 25, maxPerPage = 100) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const per_page = Math.min(maxPerPage, Math.max(1, parseInt(query.per_page) || defaultPerPage));
  const offset = (page - 1) * per_page;
  return { page, per_page, offset };
}

/**
 * Calculate pagination metadata
 * @param {number} total - Total count
 * @param {number} page - Current page
 * @param {number} per_page - Items per page
 * @returns {{page: number, per_page: number, total: number, total_pages: number}} Pagination metadata
 */
export function buildPaginationMeta(total, page, per_page) {
  const total_pages = Math.ceil(total / per_page);
  return { page, per_page, total, total_pages };
}

/**
 * Handle Supabase query errors and return standardized error response
 * @param {{message: string, details?: string, hint?: string}} error - Supabase error object
 * @param {*} res - Express response object
 * @param {string} context - Context for logging (e.g., 'fetch appointments')
 * @param {number} statusCode - HTTP status code (default 500)
 * @returns {boolean} true if error was handled
 */
export function handleQueryError(error, res, context, statusCode = 500) {
  if (!error) return false;

  logger.error({ err: error }, `Failed to ${context}`);
  res.status(statusCode).json({ error: 'Something went wrong' });
  return true;
}

/**
 * Wrap a Supabase query with consistent error handling
 * @param {Promise<{data: any, error: any}>} query - Supabase query promise
 * @param {*} res - Express response object
 * @param {string} context - Context for logging
 * @param {(data: any) => any} onSuccess - Callback on success (data) => res.json(...)
 * @param {number} errorStatusCode - HTTP status for errors
 */
export async function executeQuery(query, res, context, onSuccess, errorStatusCode = 500) {
  try {
    const { data, error } = await query;
    if (error) {
      return handleQueryError(error, res, context, errorStatusCode);
    }
    return onSuccess(data);
  } catch (err) {
    logger.error({ err }, `Unexpected error during ${context}`);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

/**
 * Build a safe search filter for PostgREST .or() queries
 * Sanitizes input to prevent injection
 * @param {string} search - Raw search input
 * @param {Array<string>} fields - Field names to search (e.g., ['first_name', 'email'])
 * @returns {string} Safe PostgREST filter or empty string
 */
export function buildSearchFilter(search, fields = []) {
  if (!search || !fields.length) return '';

  // Strip PostgREST filter metacharacters to prevent injection
  const safe = search.replace(/[^a-zA-Z0-9\s\-'.@]/g, '').trim().substring(0, 100);
  if (!safe) return '';

  return fields.map(f => `${f}.ilike.%${safe}%`).join(',');
}

/**
 * Verify authorization: ensure beautician owns the resource
 * @param {{beautician_id: string}} resource - Resource with beautician_id
 * @param {string} beautician_id - Authenticated beautician ID
 * @returns {boolean}
 */
export function authorizeBeautician(resource, beautician_id) {
  return resource && resource.beautician_id === beautician_id;
}
