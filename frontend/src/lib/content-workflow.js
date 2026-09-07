export function parseHashtags(value) {
  return [...new Set(String(value || '').split(/\s+/).filter(tag => /^#[\p{L}\p{N}_]+$/u.test(tag)))];
}
export function localScheduleValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function scheduleInstant(value, now = Date.now()) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('Choose a date and time.');
  if (date.getTime() <= now) throw new Error('Choose a time in the future.');
  return date.toISOString();
}
// No mutation retries: an interrupted response does not prove the save failed.
export async function contentRequest(url, { token, method = 'GET', body, timeoutMs = 45000, request = fetch } = {}) {
  if (!token) throw new Error('Sign in again to continue. Your request has not been sent.');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await request(url, { method, signal: controller.signal, headers: { Authorization: `Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data?.error || 'Could not complete this request.'); error.status = response.status; throw error; }
      return data;
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('This is taking too long. Your edits are still here. Check the saved result before trying again.')); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
