const REVOKED = new Set(['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show', 'rescheduled']);
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export function isCancelledBooking(appointment) {
  return ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician'].includes(appointment?.status);
}
export function managementSummaryActive(appointment, now = Date.now()) {
  if (!isCancelledBooking(appointment)) return managementLinkActive(appointment, now);
  const end = Date.parse(appointment.ends_at || appointment.starts_at || '');
  return Number.isFinite(end) && now < end + GRACE_MS;
}
export function managementLinkActive(appointment, now = Date.now()) {
  if (!appointment || REVOKED.has(appointment.status)) return false;
  const end = Date.parse(appointment.ends_at || appointment.starts_at || '');
  return Number.isFinite(end) && now < end + GRACE_MS;
}
export function bookingManagementGuard(db) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { data, error } = await db.from('appointments')
        .select('id, starts_at, ends_at, status, beauticians(booking_slug)')
        .eq('management_token', req.params.token).maybeSingle();
      if (error) return res.status(503).json({ error: 'This booking link could not be checked. Please try again.' });
      if (!data || data.beauticians?.booking_slug !== req.params.slug) return res.status(404).json({ error: 'Booking not found' });
      const summaryRequest = req.method === 'GET' && (req.path === '/' || req.path === '');
      // A cancelled link remains a receipt of what happened. Only this read
      // and an idempotent cancel retry survive; care/payment/change routes stay closed.
      const cancelRetry = req.method === 'POST' && req.path === '/cancel' && isCancelledBooking(data);
      const active = summaryRequest || cancelRetry ? managementSummaryActive(data) : managementLinkActive(data);
      if (!active) return res.status(410).json({ error: 'This booking link has expired. Please contact the salon.' });
      next();
    } catch { return res.status(503).json({ error: 'This booking link could not be checked. Please try again.' }); }
  };
}
