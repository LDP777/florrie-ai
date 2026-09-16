// Stable row IDs make a retried setup save safe after a lost response. A single
// PostgREST upsert commits the treatment list together, so a failure cannot leave
// the first treatment saved and duplicate it on the next tap.
export async function saveSetupTreatments(client, beauticianId, treatments) {
  const rows = treatments.filter(t => t.name.trim()).map((t, index) => ({
    id: t.id,
    beautician_id: beauticianId,
    name: t.name.trim(),
    duration_minutes: Number(t.duration_minutes),
    price_cents: Math.round(Number(t.price_cents) * 100),
    category: t.category,
    is_active: true,
    booking_enabled: true,
    sort_order: index,
  }));
  if (!rows.length) throw new Error('Please add at least one treatment');
  if (rows.some(t => !t.id || !Number.isInteger(t.duration_minutes) || t.duration_minutes < 1
    || !Number.isSafeInteger(t.price_cents) || t.price_cents < 0)) {
    throw new Error('Check each treatment has a valid duration and price.');
  }
  const { error } = await client.from('treatments').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
  return rows.length;
}

export function setupWorkingHours(hours) {
  const result = {};
  for (const [day, value] of Object.entries(hours)) {
    if (!value.enabled) { result[day] = null; continue; }
    const validTime = time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '');
    if (!validTime(value.start) || !validTime(value.end) || value.start >= value.end) {
      throw new Error('Each working day needs a closing time after its opening time.');
    }
    result[day] = { start: value.start, end: value.end };
  }
  return result;
}
