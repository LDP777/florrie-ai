import { randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { announceEnrolment } from './course-notifications.js';

export async function deliverCourseNotice(enrollmentId) {
  const token = randomUUID();
  const claim = await supabase.rpc('claim_course_notice', { p_id: enrollmentId, p_token: token });
  if (claim.error) throw claim.error;
  if (!claim.data) return { attempted: false };
  const notice = claim.data;
  const recordChannel = async channel => {
    const result = await supabase.rpc('mark_course_notice_channel', { p_id: enrollmentId, p_token: token, p_channel: channel });
    if (result.error) throw result.error;
  };
  let problem = null;
  try {
    const result = await announceEnrolment({ ...notice.snapshot,
      delivery: { email: !notice.email_done, web: !notice.web_done, apns: !notice.apns_done },
      onDelivered: recordChannel, emailIdempotencyKey: `course-confirmation-${enrollmentId}` });
    problem = result?.failures?.join('; ') || null;
  } catch (err) {
    problem = 'Confirmation delivery interrupted';
    logger.warn({ err, enrollmentId }, problem);
  }
  const finish = await supabase.rpc('finish_course_notice', { p_id: enrollmentId, p_token: token, p_error: problem });
  if (finish.error) throw finish.error;
  return { attempted: true, retryPending: !!problem };
}

export async function retryCourseNotices() {
  const { data, error } = await supabase.from('course_enrollment_notices').select('enrollment_id')
    .is('completed_at', null).lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true }).order('enrollment_id', { ascending: true }).limit(25);
  if (error) throw error;
  let attempted = 0;
  for (const row of data || []) {
    const result = await deliverCourseNotice(row.enrollment_id);
    if (result.attempted) attempted++;
  }
  return { attempted };
}
