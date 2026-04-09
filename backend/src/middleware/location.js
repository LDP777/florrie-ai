/**
 * Location-scoping middleware.
 *
 * Reads `x-location-id` header (set by frontend location selector).
 * Attaches req.locationId which routes can use to scope queries.
 *
 * If no header is sent, req.locationId is null — queries return all locations.
 * This makes multi-location opt-in and backwards-compatible.
 */
import { supabase } from '../index.js';

export function locationScope(req, res, next) {
  const locationId = req.headers['x-location-id'] || null;

  if (locationId && locationId !== 'all') {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(locationId)) {
      return res.status(400).json({ error: 'Invalid location ID' });
    }
    req.locationId = locationId;
  } else {
    req.locationId = null; // No location filter — show all
  }

  next();
}

/**
 * Helper: add location filter to a Supabase query builder.
 * Returns the query unchanged if locationId is null.
 */
export function withLocation(query, locationId, column = 'location_id') {
  if (!locationId) return query;
  return query.eq(column, locationId);
}
