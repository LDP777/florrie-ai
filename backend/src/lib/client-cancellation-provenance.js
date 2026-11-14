import { isCancelledBooking } from './booking-management-access.js';

// The cancellation transaction stamps both rows. A staged request or a later
// cancellation by somebody else cannot authorise payment or notification.
export function matchesClientCancellation(intent, appointment) {
  return isCancelledBooking(appointment) && intent?.beautician_id === appointment?.beautician_id
    && intent?.appointment_id === appointment?.id && intent?.details?.source === 'client_manage'
    && Number.isFinite(Date.parse(intent.details.cancelled_at))
    && Date.parse(intent.details.cancelled_at) === Date.parse(appointment.cancelled_at);
}
