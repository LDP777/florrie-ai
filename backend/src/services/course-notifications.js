/**
 * Telling people a course place has been taken.
 *
 * Two people need to hear it and neither did. The student got a "You're in!"
 * screen and nothing she could find again: no date in her inbox, nothing in
 * her calendar, no way to reach the trainer. The trainer got nothing at all;
 * an enrolment on a seven hundred and fifty pound course showed up only if
 * she happened to open the Courses page.
 *
 * Both are told from ONE function so the Stripe webhook and the no-deposit
 * path cannot drift apart, and it never throws: an enrolment is already
 * written by the time this runs, and a failed email must not turn into a
 * failed enrolment.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { sendEmail } from './notifications.js';
import { pushTeamUpdate } from './push-notifications.js';
import { appointmentIcs } from '../lib/ical.js';
import { formatCourseDate } from '../lib/training-enquiry.js';
import { balanceDue } from '../lib/course-enrolment.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

/** Course length in minutes from its duration label, for the calendar file. */
export function durationMinutes(label) {
  const s = String(label || '').toLowerCase();
  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)/);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const days = s.match(/(\d+)\s*days?/);
  if (days) return Number(days[1]) * 7 * 60;
  if (/half day/.test(s)) return 4 * 60;
  if (/full day/.test(s)) return 7 * 60;
  return 7 * 60;
}

/**
 * Start and end as London wall-clock ISO strings, or null when the course has
 * no date yet. A course with a date but no start time is put down for nine in
 * the morning and SAYS SO in the email; the trainer confirms the time.
 */
export function courseWindow(course) {
  if (!course?.date) return null;
  const day = String(course.date).slice(0, 10);
  const time = course.start_time ? String(course.start_time).slice(0, 5) : '09:00';
  const startsAt = `${day}T${time}:00`;
  const start = new Date(`${startsAt}Z`);
  const end = new Date(start.getTime() + durationMinutes(course.duration) * 60 * 1000);
  return { startsAt, endsAt: end.toISOString().slice(0, 19), timeAssumed: !course.start_time };
}

/**
 * @param {object} a
 * @param {object} a.beautician id, first_name, business_name, email, phone, booking_slug
 * @param {object} a.course the courses row
 * @param {object} a.enrollment the course_enrollments row, after any payment update
 * @param {'paid'|'deposit'|'unpaid'} a.paid what has been paid
 */
export async function announceEnrolment({ beautician, course, enrollment, paid }) {
  const trainer = beautician?.business_name || beautician?.first_name || 'your trainer';
  const student = enrollment?.name || 'A student';
  const when = course?.date ? formatCourseDate(course.date) : 'date to be confirmed';

  // The owner. Its own headline, because "New booking" is a treatment and this
  // is a student, and because at a glance she should know the money landed.
  try {
    const money = paid === 'paid' ? 'Paid in full.'
      : paid === 'deposit' ? `Deposit paid (£${(Number(enrollment?.amount_paid_cents || 0) / 100).toFixed(0)}).`
      : Number(course?.deposit) > 0 ? `Deposit of £${Number(course.deposit).toFixed(0)} still to collect.` : '';
    await pushTeamUpdate(beautician.id, 'course_enrolled',
      `${student} booked onto ${course?.name || 'your course'}, ${when}. ${money}`.trim(),
      { url: '/packages', clientName: student });
  } catch (err) {
    logger.warn({ err, enrollmentId: enrollment?.id }, 'Course enrolment push failed (non-fatal)');
  }

  // The student. One email with everything she will otherwise message to ask.
  if (!enrollment?.email) return;
  try {
    const window = courseWindow(course);
    const due = balanceDue(course, enrollment);
    const link = `${FRONTEND_URL}/training/${beautician.booking_slug || 'book'}/${course.id}`;
    const contact = [beautician?.email ? `email ${beautician.email}` : null, beautician?.phone ? `WhatsApp ${beautician.phone}` : null].filter(Boolean).join(' or ');
    const paidLine = paid === 'paid'
      ? 'You have paid in full. Nothing more to pay.'
      : paid === 'deposit'
        ? `Your deposit of £${(Number(enrollment.amount_paid_cents || 0) / 100).toFixed(2)} is paid. £${due.toFixed(2)} is due on the day.`
        : Number(course?.deposit) > 0
          ? `A deposit of £${Number(course.deposit).toFixed(2)} secures your place. ${trainer} will be in touch to arrange it. £${due.toFixed(2)} in total is still to pay.`
          : `£${due.toFixed(2)} is due on the day.`;
    const includes = Array.isArray(course?.includes) && course.includes.length
      ? `<p><strong>Included:</strong> ${course.includes.map(labelFor).join(', ')}.</p>` : '';
    const timeLine = window
      ? (window.timeAssumed ? `${when}. ${trainer} will confirm the start time.` : `${when}, starting ${String(course.start_time).slice(0, 5)}.`)
      : `Date to be confirmed. ${trainer} will let you know.`;

    const html = `
      <p>Hi ${enrollment.name?.split(' ')[0] || 'there'},</p>
      <p>Your place on <strong>${course?.name || 'the course'}</strong> with ${trainer} is booked.</p>
      <p><strong>When:</strong> ${timeLine}<br>
      ${course?.duration ? `<strong>Length:</strong> ${course.duration}<br>` : ''}
      ${course?.location ? `<strong>Where:</strong> ${course.location}<br>` : ''}
      <strong>Price:</strong> £${Number(course?.price || 0).toFixed(2)}</p>
      <p>${paidLine}</p>
      ${includes}
      ${enrollment.notes ? `<p><strong>You told us:</strong> ${escapeHtml(enrollment.notes)}</p>` : ''}
      <p>Questions? ${contact ? `Reply to this email, or ${contact}.` : 'Reply to this email.'}</p>
      <p style="color:#999;font-size:12px;">Course page: <a href="${link}">${link}</a></p>
    `;
    const text = html.replace(/<[^>]+>/g, '').replace(/\n\s+/g, '\n').trim();

    // sendEmail base64-encodes attachment content itself; hand it the text.
    const attachments = window ? [{
      filename: 'course.ics',
      content: appointmentIcs({
        id: `course-${enrollment.id}`,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        treatmentName: course.name,
        businessName: trainer,
        location: course.location || undefined,
        manageUrl: link,
      }),
      contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
    }] : undefined;

    await sendEmail({
      to: enrollment.email,
      subject: `Your place on ${course?.name || 'the course'} is booked`,
      html,
      text,
      attachments,
      replyTo: beautician?.email || undefined,
    });
  } catch (err) {
    logger.warn({ err, enrollmentId: enrollment?.id }, 'Course enrolment email failed (non-fatal)');
  }
}

/** Load what announceEnrolment needs from ids, for the webhook. Never throws. */
export async function announceEnrolmentById(enrollmentId, paid) {
  try {
    const { data: enrollment } = await supabase
      .from('course_enrollments').select('*').eq('id', enrollmentId).single();
    if (!enrollment) return;
    const [{ data: course }, { data: beautician }] = await Promise.all([
      supabase.from('courses').select('*').eq('id', enrollment.course_id).single(),
      supabase.from('beauticians').select('id, first_name, business_name, email, phone, booking_slug').eq('id', enrollment.beautician_id).single(),
    ]);
    if (!course || !beautician) return;
    await announceEnrolment({ beautician, course, enrollment, paid });
  } catch (err) {
    logger.warn({ err, enrollmentId }, 'Course enrolment announcement failed (non-fatal)');
  }
}

const INCLUDES = {
  certificate: 'Certificate', kit: 'Starter kit', manual: 'Course manual', lunch: 'Lunch',
  refreshments: 'Refreshments', models: 'Live models', aftercare: 'Aftercare pack',
};
function labelFor(key) { return INCLUDES[key] || String(key); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
