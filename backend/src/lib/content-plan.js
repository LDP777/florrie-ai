export const CONTENT_GOALS = {
  show_work: 'Introduce the treatment, explain a detail of the work, then invite a booking. No photo is supplied, so do not describe a visual result.',
  explain: 'Introduce the treatment, answer a question using supplied treatment facts, then explain how to find out more. Do not invent suitability, preparation or aftercare instructions.',
  trust: 'Introduce the salon approach using known facts, share an available public review without changing its meaning, then invite a conversation. If there is no public review, use a factual salon introduction instead.',
  bookings: 'Introduce a treatment, explain the visit using known facts, then direct clients to the booking page. Availability has not been checked. Never claim a cancellation, urgency, a free slot or an appointment time.',
};

export function contentPlanOptions(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Choose a content goal.');
  const goal = body.goal ?? null;
  const postCount = body.post_count ?? 7;
  const treatmentId = body.treatment_id ?? null;
  if (goal !== null && !Object.hasOwn(CONTENT_GOALS, goal)) throw new Error('Choose a valid content goal.');
  if (![3, 7].includes(postCount)) throw new Error('Choose a three-post plan or a full week.');
  if (treatmentId !== null && (typeof treatmentId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(treatmentId))) throw new Error('Choose a treatment from your salon.');
  return { goal, post_count: postCount, treatment_id: treatmentId };
}
