import { expect, it } from 'vitest';
import { activityReceipt } from '../../src/lib/activity-receipt.js';
it('only completed outcomes earn sent or filled claims', () => {
  const rows = [
    { action_type: 'appointment_reminder', outcome: 'failed' },
    { action_type: 'appointment_reminder', outcome: 'pending' },
    { action_type: 'appointment_reminder', outcome: 'success' },
    { action_type: 'gap_fill_waitlist', outcome: 'success', summary: '£45 gap' },
    { action_type: 'gap_fill', outcome: 'failed' },
    { action_type: 'message_escalated', outcome: 'escalated' },
    { action_type: 'message_replied', outcome: 'success', details: { heartbeat: true } },
    { action_type: 'time_protected', outcome: 'success' },
  ];
  expect(activityReceipt(rows).map(r => r.text)).toEqual(['1 reminder sent', '1 space protected in your diary', '2 actions could not finish', '1 action not yet confirmed', '1 enquiry handed to you']);
});
it('distinct events with identical descriptions both count', () => {
  expect(activityReceipt([1,2].map(id => ({ id, action_type: 'message_replied', outcome: 'success', summary: 'Reply sent' })))[0].text).toBe('2 client replies sent');
});
