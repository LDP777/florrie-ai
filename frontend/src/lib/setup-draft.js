// Drafts contain setup fields only. Names, client records and credentials from
// other screens never enter this store. Saved server settings remain authoritative.
const keyFor = id => `florrie-setup-draft-v1:${id}`;
export function readSetupDraft(storage, id, now = Date.now()) {
  try {
    const d = JSON.parse(storage.getItem(keyFor(id)));
    if (!d || !Number.isFinite(d.savedAt) || now - d.savedAt > 30 * 86400000 || d.savedAt > now
      || !Number.isInteger(d.step) || d.step < 1 || d.step > 6) return null;
    if (!Array.isArray(d.treatments) || d.treatments.length > 100 || !d.treatments.every(t =>
      /^[a-f0-9-]{36}$/i.test(t.id) && typeof t.name === 'string' && t.name.length <= 200)) return null;
    if (!d.hours || typeof d.hours !== 'object') return null;
    for (const field of ['businessName', 'firstName', 'slug']) if (typeof d[field] !== 'string' || d[field].length > 500) return null;
    return d;
  } catch { return null; }
}
export function writeSetupDraft(storage, id, value) {
  if (!id) return;
  try { storage.setItem(keyFor(id), JSON.stringify({ ...value, savedAt: Date.now() })); } catch { /* Storage may be unavailable; completed steps are still saved online. */ }
}
export function clearSetupDraft(storage, id) { try { storage.removeItem(keyFor(id)); } catch {} }
