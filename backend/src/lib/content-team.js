/** Bounded, draft-only Content Team contracts. No provider or database access. */
export const TEAM_STAGES = ['strategy', 'writing', 'reels'];
export const TEAM_GOALS = ['bookings', 'show_work', 'explain', 'trust'];
export const TEAM_ATTEMPT_LIMIT = 3;
export const TEAM_CAPABILITIES = [
  { id: 'strategy', name: 'Content planner', state: 'available', description: 'Plans three related ideas from your saved salon facts.' },
  { id: 'writing', name: 'Post writer', state: 'available', description: 'Prepares captions and opening lines for your review.' },
  { id: 'reels', name: 'Reel scripter', state: 'available', description: 'Writes a filming plan. You supply the footage.' },
];
export const isTeamUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const teamError = (message, status = 503, code = 'unavailable') => Object.assign(new Error(message), { status, code, isContentTeamError: true });

// The provider supports the structure, not string lengths or array counts.
// Keep those limits in validateTeamOutput; never truncate a factual qualification.
// These schemas are static: salon facts belong in the message, not cached schemas.
const schemaText = description => ({ type: 'string', description });
const schemaObject = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const schemaList = (description, items) => ({ type: 'array', description, items });
const schemaFormat = { type: 'string', enum: ['feed', 'story', 'reel'], description: 'The intended format. A reel is a filming plan; no footage exists yet.' };
const schemaRefs = schemaList('Copy one to four exact source ids from the supplied sources. Do not invent ids.', schemaText('An exact supplied source id.'));
const TEAM_OUTPUT_SCHEMAS = {
  strategy: schemaObject({
    summary: schemaText('One or two short sentences, aim for 250 characters; maximum 800 characters including spaces.'),
    posts: schemaList('Exactly three connected ideas, including one reel.', schemaObject({
      title: schemaText('A short title, aim for 60 characters; maximum 120 characters including spaces.'),
      angle: schemaText('One short sentence explaining the idea, aim for 160 characters; maximum 500 characters including spaces. Preserve any factual qualifications.'),
      format: schemaFormat,
      source_note: schemaText('Briefly name the saved evidence, aim for 80 characters; maximum 240 characters including spaces.'),
      source_refs: schemaRefs,
    })),
  }),
  writing: schemaObject({
    posts: schemaList('Exactly one caption for each of the three supplied strategy posts.', schemaObject({
      id: schemaText('Copy the exact id from the matching strategy post. Use each strategy id once.'),
      caption: schemaText('Finished client-facing draft copy only, never filming directions, asset requests or notes to the owner. For story: aim for 160 characters, maximum 240 characters. For feed or reel: aim for 400 characters, maximum 2200 characters. All counts include spaces. Preserve factual qualifications. Never assume a link is in the bio or profile.'),
      format: schemaFormat,
    })),
    hooks: schemaList('One to five short alternative opening lines.', schemaText('Aim for 60 characters; maximum 180 characters including spaces.')),
  }),
  reels: schemaObject({
    title: schemaText('A short title, aim for 60 characters; maximum 120 characters including spaces.'),
    hook: schemaText('A short opening line, aim for 80 characters; maximum 200 characters including spaces.'),
    shots: schemaList('Two to six achievable shots, preferably three. These are filming instructions for the owner, not footage already created.', schemaObject({
      shot: schemaText('One short filming instruction, aim for 120 characters; maximum 300 characters including spaces.'),
      spoken: schemaText('A short spoken line, aim for 160 characters; maximum 500 characters including spaces. Preserve factual qualifications.'),
      on_screen: schemaText('A short phrase for the screen, aim for 50 characters; maximum 180 characters including spaces.'),
    })),
    caption: schemaText('Finished client-facing draft copy only, never filming directions, asset requests or notes to the owner. Aim for 400 characters; maximum 2200 characters including spaces. Preserve factual qualifications. Never assume a link is in the bio or profile.'),
    needs: schemaList('Zero to five footage, permission or missing-fact requests.', schemaText('One concise request, aim for 100 characters; maximum 240 characters including spaces.')),
    source_refs: schemaRefs,
  }),
};

export function teamOutputFormat(stage) {
  const schema = TEAM_OUTPUT_SCHEMAS[stage];
  if (!schema) throw teamError('Unknown Content Team step.', 400, 'invalid_stage');
  return { type: 'json_schema', schema };
}

export function contentTeamPagination(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['offset', 'limit'].includes(key))) throw teamError('Choose a valid page of saved work.', 400, 'invalid_page');
  const integer = (value, fallback, min, max) => {
    if (value == null) return fallback;
    if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw teamError('Choose a valid page of saved work.', 400, 'invalid_page');
    return Number(value);
  };
  return { offset: integer(query.offset, 0, 0, 100000), limit: integer(query.limit, 20, 1, 50) };
}

export const publicTeamSummary = row => ({ id: row.id, request_id: row.request_id, brief: row.brief, status: row.status, created_at: row.created_at, updated_at: row.updated_at });

export function contentTeamRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['request_id', 'goal', 'focus', 'treatment_id'].includes(key))) throw teamError('Choose a content goal and a short brief.', 400, 'invalid_request');
  if (!isTeamUuid(body.request_id) || !TEAM_GOALS.includes(body.goal) || typeof body.focus !== 'string' || body.focus.length > 600 || (body.treatment_id != null && !isTeamUuid(body.treatment_id))) throw teamError('Choose a valid goal, treatment and a brief of up to 600 characters.', 400, 'invalid_request');
  return { request_id: body.request_id.toLowerCase(), brief: { goal: body.goal, focus: body.focus.trim(), treatment_id: body.treatment_id?.toLowerCase() || null } };
}
export const emptyTeamStages = () => TEAM_STAGES.map(id => ({ id, status: 'waiting', output: null, attempts: 0 }));
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw teamError(`The ${label} was incomplete. Retry this step.`, 503, 'invalid_output');
  return value.trim();
};
const publicText = (value, max, label) => {
  const result = text(value, max, label);
  // No profile/bio link has been verified for this source snapshot.
  if (/\blink\s+(?:in|on)\s+(?:(?:my|our|your|the)\s+)?(?:bio|profile)\b|\b(?:bio|profile)\s+link\b/i.test(result)) throw teamError('The draft assumed a booking link in your profile. Retry this step.', 503, 'invalid_output');
  return result;
};
const clientCaption = (value, max, label) => {
  const result = publicText(value, max, label);
  // Reject explicit production labels, not normal client-facing talk about filming.
  if (/^[\t ]*(?:[-*][\t ]+)?(?:\*\*)?(?:filming plan|assets? needed|shot list)[\t ]*(?:\*\*)?[\t ]*:/im.test(result)) throw teamError('The caption included filming instructions for the owner. Retry this step.', 503, 'invalid_output');
  return result;
};
const array = (value, min, max, label) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw teamError(`The ${label} was incomplete. Retry this step.`, 503, 'invalid_output');
  return value;
};
const format = value => {
  if (!['feed', 'story', 'reel'].includes(value)) throw teamError('The post format was not recognised. Retry this step.', 503, 'invalid_output');
  return value;
};
const refs = (value, sourceIds) => {
  const values = array(value, 1, 4, 'source references');
  if (values.some(ref => typeof ref !== 'string' || !sourceIds.has(ref))) throw teamError('The draft cited a source that was not supplied. Retry this step.', 503, 'invalid_output');
  return [...new Set(values)];
};

/** Model ids are never accepted for new work; references must resolve to the current snapshot. */
export function validateTeamOutput(stage, raw, { runId, sourceIds, strategy }) {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > 20000) throw teamError('The response was too long. Retry this step.', 503, 'invalid_output');
    try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw teamError('Florrie returned an unreadable draft. Retry this step.', 503, 'invalid_output'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw teamError('Florrie returned an incomplete draft. Retry this step.', 503, 'invalid_output');
  if (stage === 'strategy') {
    const posts = array(value.posts, 3, 3, 'content plan').map((post, index) => ({
      id: `${runId}:idea:${index + 1}`, title: text(post?.title, 120, 'title'), angle: text(post?.angle, 500, 'angle'),
      format: format(post?.format), source_note: text(post?.source_note, 240, 'source note'), source_refs: refs(post?.source_refs, sourceIds),
    }));
    if (!posts.some(post => post.format === 'reel')) throw teamError('The plan needs a filming idea. Retry this step.', 503, 'invalid_output');
    return { summary: text(value.summary, 800, 'plan summary'), posts };
  }
  if (stage === 'writing') {
    const planned = new Map((strategy?.posts || []).map(post => [post.id, post]));
    const seen = new Set();
    const posts = array(value.posts, 3, 3, 'captions').map(post => {
      const idea = planned.get(post?.id);
      if (!idea || seen.has(post.id) || post.format !== idea.format) throw teamError('The captions did not match your plan. Retry this step.', 503, 'invalid_output');
      seen.add(post.id);
      return { id: idea.id, title: idea.title, caption: clientCaption(post.caption, idea.format === 'story' ? 240 : 2200, 'caption'), format: idea.format, source_note: idea.source_note, source_refs: idea.source_refs };
    });
    return { posts, hooks: array(value.hooks, 1, 5, 'opening lines').map(hook => publicText(hook, 180, 'opening line')) };
  }
  if (stage === 'reels') {
    return { id: `${runId}:reel:1`, title: text(value.title, 120, 'Reel title'), hook: publicText(value.hook, 200, 'Reel opening'),
      shots: array(value.shots, 2, 6, 'filming plan').map(shot => ({ shot: text(shot?.shot, 300, 'shot'), spoken: publicText(shot?.spoken, 500, 'spoken line'), on_screen: publicText(shot?.on_screen, 180, 'on-screen text') })),
      caption: clientCaption(value.caption, 2200, 'Reel caption'),
      needs: [...new Set(['Film the listed shots with your own footage. Review the facts and any photo permissions before sharing.', ...array(value.needs, 0, 5, 'filming needs').map(need => text(need, 240, 'filming need'))])],
      source_refs: refs(value.source_refs, sourceIds) };
  }
  throw teamError('Unknown Content Team step.', 400, 'invalid_stage');
}

export function publicTeamRun(row) {
  if (!row) return null;
  return { id: row.id, request_id: row.request_id, status: row.status, brief: row.brief,
    stages: (row.stages || []).map(({ id, status, output, error }) => ({ id, status, output: output || null, ...(error ? { error } : {}) })),
    created_at: row.created_at, updated_at: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
    retryable: row.status === 'failed' && row.failure_code !== 'source_changed' && row.failure_code !== 'owner_unavailable' && (row.stages || []).some(stage => stage.status === 'failed' && stage.attempts < TEAM_ATTEMPT_LIMIT) };
}
