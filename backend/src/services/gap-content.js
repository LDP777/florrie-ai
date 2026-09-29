import { supabase } from '../config.js';
import { currentGapCalendar, gapError, gapRequest, selectCurrentGaps } from '../lib/gap-availability.js';
import { draftAvailabilityPost } from './content-autopilot.js';

function tomorrowInSalon(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return new Date(Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

async function activeTreatments(beauticianId, ids) {
  let query = supabase.from('treatments')
    .select('id, name, duration_minutes, buffer_minutes', { count: 'exact' })
    .eq('beautician_id', beauticianId).eq('is_active', true);
  if (ids) query = query.in('id', ids);
  const { data, error, count } = await query;
  if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count !== data.length) {
    throw gapError('availability_unavailable', 'Could not check the treatments for this opening. Please try again.');
  }
  return data.filter(t => typeof t.id === 'string' && typeof t.name === 'string' && t.name.trim()
    && Number.isFinite(Number(t.duration_minutes)) && Number(t.duration_minutes) > 0
    && Number.isFinite(Number(t.buffer_minutes ?? 0)) && Number(t.buffer_minutes ?? 0) >= 0);
}

function fitting(treatments, gap) {
  return treatments.filter(t => Number(t.duration_minutes) + Number(t.buffer_minutes ?? 0) <= gap.duration_minutes);
}

function evidence(gap, treatments, now) {
  return {
    gap: { date: gap.date, start: gap.start, end: gap.end, duration_minutes: gap.duration_minutes },
    treatment_ids: treatments.map(t => t.id),
    treatment_names: treatments.map(t => t.name.trim()),
    checked_at: now.toISOString(),
  };
}

/** Only tomorrow's real, fitting gaps can create a background suggestion. */
export async function findGapPostOpportunity(beauticianId, now = new Date()) {
  const calendar = await currentGapCalendar(beauticianId, now);
  const date = tomorrowInSalon(now, calendar.beautician.timezone);
  const gaps = selectCurrentGaps(calendar.gaps, { date });
  // Preserve the existing two-hour trigger, using actual unoccupied intervals.
  if (gaps.reduce((total, gap) => total + gap.duration_minutes, 0) < 120) return null;
  const treatments = await activeTreatments(beauticianId);
  for (const gap of gaps) {
    const candidates = fitting(treatments, gap).slice(0, 5);
    if (candidates.length) return evidence(gap, candidates, now);
  }
  return null;
}

/** Stored evidence identifies the approved slot; it is never trusted as availability. */
export async function verifyGapPostOpportunity(beauticianId, details, now = new Date()) {
  if (!details?.gap || !Array.isArray(details.treatment_ids) || !details.treatment_ids.length
    || details.treatment_ids.some(id => typeof id !== 'string' || !id)) {
    throw gapError('gap_unavailable', 'This suggestion has no verified opening. Dismiss it and use the current gaps in Schedule.');
  }
  const target = gapRequest({ date: details.gap.date, start_time: details.gap.start, end_time: details.gap.end });
  if (!target.start) throw gapError('gap_unavailable', 'This suggestion has no verified opening. Refresh Schedule.');
  const calendar = await currentGapCalendar(beauticianId, now);
  const gap = selectCurrentGaps(calendar.gaps, target)[0];
  const treatments = await activeTreatments(beauticianId, [...new Set(details.treatment_ids)]);
  const candidates = fitting(treatments, gap);
  if (!candidates.length) throw gapError('gap_unavailable', 'The treatments no longer fit this opening. Refresh Schedule.');
  return evidence(gap, candidates, now);
}

export async function draftVerifiedGapPost(beauticianId, details) {
  const verified = await verifyGapPostOpportunity(beauticianId, details);
  const post = await draftAvailabilityPost(beauticianId, verified.gap.date, verified.gap.start, verified.treatment_names, {
    bookingInvitationOnly: true,
    // The model may take time. Check again before its caption becomes a saved draft.
    beforeSave: async () => {
      const latest = await verifyGapPostOpportunity(beauticianId, verified);
      const namesById = new Map(latest.treatment_ids.map((id, index) => [id, latest.treatment_names[index]]));
      if (latest.treatment_ids.length !== verified.treatment_ids.length
        || verified.treatment_ids.some((id, index) => namesById.get(id) !== verified.treatment_names[index])) {
        throw gapError('gap_unavailable', 'The treatments changed while preparing this post. Please try again.');
      }
    },
  });
  if (!post?.id) throw new Error('Could not save the availability draft.');
  return { post, details: { ...verified, post_id: post.id } };
}
