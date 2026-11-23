export const asArray = value => Array.isArray(value) ? value : [];
export const postTitle = post => post?.purpose?.title || 'Your post';
export const shortTitle = post => post?.purpose?.short || post?.purpose?.label || postTitle(post);
export const postImage = post => post?.image_url || post?.media?.image_url || post?.media?.url || post?.media?.after_url || '';
export const postTime = post => post?.timing?.at ?? post?.scheduled_for;
export const isBlocked = post => post?.change_note?.kind === 'blocked' || asArray(post?.facts).some(fact => fact.status === 'block');
export const needsChecking = post => post?.status === 'draft' || ['ready', 'needs_ok', 'needs_input', 'Ready to check', 'Needs your OK again', 'Needs a decision'].includes(post?.state);
export const stateLabel = post => ({ ready: 'Ready to check', needs_ok: 'Needs your OK again', needs_input: 'Needs a decision', approved_hold: 'Approved, not scheduled', scheduled: 'Scheduled', waiting_connection: 'Waiting for Instagram', publishing: 'Posting', published: 'Posted', failed: "Didn't post", plan: 'To film' }[post?.state] || post?.state || ({draft:'Ready to check',approved:'Approved, not scheduled',scheduled:'Scheduled',posted:'Posted',failed:"Didn't post"}[post?.status]) || 'Ready to check');
export const money = pence => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: Number(pence) % 100 ? 2 : 0 }).format(Number(pence || 0) / 100);
export function when(value, timezone) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'when you choose a time';
  return new Intl.DateTimeFormat('en-GB', { weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit', ...(timezone ? {timeZone:timezone} : {}) }).format(new Date(value));
}
export function readLocal(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function saveLocal(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* Saved server work remains available. */ } }
