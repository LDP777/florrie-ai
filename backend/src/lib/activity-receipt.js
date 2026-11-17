/** A receipt describes recorded outcomes, never infers money from prose. */
export function activityReceipt(rows) {
  const work = rows.filter(r => !r.details?.heartbeat);
  const successes = work.filter(r => r.outcome === 'success');
  const count = types => successes.filter(r => types.includes(r.action_type)).length;
  const lines = [];
  const add = (n, icon, one, many = `${one}s`) => { if (n) lines.push({ icon, text: `${n} ${n === 1 ? one : many}` }); };
  add(count(['message_replied']), 'message', 'client reply sent', 'client replies sent');
  add(count(['appointment_reminder','prearrival_reminder']), 'clock', 'reminder sent', 'reminders sent');
  add(count(['booking_created']), 'calendar', 'booking or hold created', 'bookings or holds created');
  add(count(['booking_rescheduled']), 'refresh', 'booking moved', 'bookings moved');
  // A successful offer is not a filled gap. Only the completed-fill event earns that claim.
  add(count(['cancellation_filled']), 'sparkles', 'cancelled slot filled', 'cancelled slots filled');
  add(count(['review_requested']), 'star', 'review request sent', 'review requests sent');
  add(count(['time_protected']), 'calendar', 'space protected in your diary', 'spaces protected in your diary');
  add(work.filter(r => r.outcome === 'failed').length, 'alert-triangle', 'action could not finish', 'actions could not finish');
  add(work.filter(r => r.outcome === 'pending').length, 'clock', 'action not yet confirmed', 'actions not yet confirmed');
  add(work.filter(r => r.outcome === 'escalated').length, 'message', 'enquiry handed to you', 'enquiries handed to you');
  return lines;
}
