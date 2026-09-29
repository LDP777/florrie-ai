const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VIEWS = new Set(['ideas', 'drafts', 'posted', 'results', 'calendar', 'gallery']);
const AVAILABILITY_BRIEF = 'Write a short Instagram post inviting clients to check my booking page for current availability. This brief came from Schedule, whose diary view is a snapshot, not a current availability check. Do not claim a cancellation, an opening, a date or time, a discount or urgency. Use only saved salon and treatment facts.';

/** A refreshed post belongs in one status bucket, including when it leaves this one. */
export function mergeContentPosts(previous, incoming, statuses, append = false) {
  const validRows = rows => (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.id === 'string');
  const latest = new Map(validRows(incoming).map(row => [row.id, row]));
  const retained = append ? validRows(previous).filter(row => !latest.has(row.id)) : [];
  return [...new Map([...retained, ...latest.values()].map(row => [row.id, row])).values()]
    .filter(row => row.post_type !== 'gallery' && statuses.includes(row.status));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

/** Navigation carries context only. It never reserves a gap or approves a post. */
export function scheduleContentHandoff(gap = null, treatment = '') {
  const date = validDate(gap?.date);
  const start = validTime(gap?.start);
  const end = validTime(gap?.end);
  const hasGap = !!date && !!start && !!end && start < end;
  const name = typeof treatment === 'string' ? treatment.trim().slice(0, 160) : '';
  return {
    contentBrief: {
      source: 'schedule',
      date: hasGap ? date : null,
      // Salon wall-clock values deliberately have no timezone suffix.
      startsAt: hasGap ? `${date}T${start}:00` : null,
      endsAt: hasGap ? `${date}T${end}:00` : null,
      ...(name ? { treatment: name } : {}),
      brief: AVAILABILITY_BRIEF,
    },
  };
}

/** Read only supported handoffs; an exact post must still be owner-scoped on load. */
export function readContentHandoff(state, search = '') {
  const input = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const query = new URLSearchParams(typeof search === 'string' ? search : '');
  const candidate = input.contentPostId ?? query.get('post');
  const postId = typeof candidate === 'string' && UUID.test(candidate) ? candidate : null;
  const candidateView = input.contentView ?? query.get('view');
  const view = VIEWS.has(candidateView) ? candidateView : input.showDrafts || postId ? 'drafts' : null;
  let brief = null;
  if (input.contentBrief?.source === 'schedule') {
    const passed = input.contentBrief;
    const date = validDate(passed.date);
    const start = typeof passed.startsAt === 'string' && passed.startsAt.length === 19 && passed.startsAt.startsWith(`${date}T`) && passed.startsAt.endsWith(':00') ? passed.startsAt.slice(11, 16) : null;
    const end = typeof passed.endsAt === 'string' && passed.endsAt.length === 19 && passed.endsAt.startsWith(`${date}T`) && passed.endsAt.endsWith(':00') ? passed.endsAt.slice(11, 16) : null;
    brief = scheduleContentHandoff({ date, start, end }, passed.treatment).contentBrief;
  }
  return { postId, view, brief };
}
