// Learning the owner's voice from edits she ACCEPTS (edits on a post she then
// approves). Florrie's own unedited drafts never train the voice: that is the
// feedback loop the idiolect work found in messaging (authored_by), and the
// same rule applies to captions.

const words = text => (text || '').match(/[\p{L}\p{N}'’£#.,!?]+|\s+/gu)?.filter(w => !/^\s+$/.test(w)) || [];
const norm = w => w.toLowerCase().replace(/[.,!?]+$/g, '').replace(/’/g, "'");
const FACTY = /[£\d]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|am|pm)\b/i;

function lcs(a, b) {
  a = a.slice(0, 600); b = b.slice(0, 600);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (norm(a[i]) === norm(b[j])) { ops.push(['=', a[i], b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', null, b[j]]); j++; }
  }
  while (i < m) ops.push(['-', a[i++]]);
  while (j < n) ops.push(['+', null, b[j++]]);
  return ops;
}

/** Word-level changes between two captions, as [{removed, added}] runs. */
export function changes(before, after) {
  const ops = lcs(words(before), words(after));
  const runs = [];
  let cur = null;
  for (const [op, a, b] of ops) {
    if (op === '=') { if (cur) runs.push(cur); cur = null; continue; }
    cur ||= { removed: [], added: [] };
    if (op === '-') cur.removed.push(a); else cur.added.push(b);
  }
  if (cur) runs.push(cur);
  return runs;
}

const clean = list => list.join(' ').replace(/[.,!?]+$/g, '').trim();

/** Rules worth keeping from one accepted edit. Fact edits (prices, days, times) are not voice. */
export function learnFromEdit(before, after, at = new Date().toISOString(), {beforeHashtags,afterHashtags} = {}) {
  const rules = [];
  for (const run of changes(before, after)) {
    const from = clean(run.removed), to = clean(run.added);
    if (!from || !to) continue;
    if (run.removed.length > 6 || run.added.length > 6) continue;
    if (FACTY.test(from) || FACTY.test(to)) continue;
    if (from.toLowerCase() === to.toLowerCase()) continue;
    rules.push({ kind: 'replace', from_text: from, to_text: to, learned_at: at });
  }
  const hadBang = /!/.test(before), hasBang = /!/.test(after);
  if (hadBang && !hasBang) rules.push({ kind: 'no_exclaim', learned_at: at });
  const signOff = /(?:^|\s)(x{1,3})\s*$/i.exec(after);
  if (signOff && !/(?:^|\s)x{1,3}\s*$/i.test(before)) rules.push({ kind: 'sign_off', value: signOff[1].toLowerCase(), learned_at: at });
  if(Array.isArray(beforeHashtags) && Array.isArray(afterHashtags) && afterHashtags.length<beforeHashtags.length) {
    rules.push({kind:'max_hashtags',value:String(afterHashtags.length),learned_at:at});
  }
  return rules;
}

export function applyHashtagRules(hashtags,rules=[]) {
  const limits=rules.filter(r=>r.kind==='max_hashtags' && /^\d+$/.test(String(r.value))).map(r=>Number(r.value));
  return (hashtags || []).map(tag=>tag.startsWith('#')?tag:`#${tag}`).slice(0,limits.length?Math.min(...limits):30);
}

export function applyVoice(text, rules = []) {
  let out = text;
  for (const r of rules) {
    if (r.kind === 'replace') {
      const re = new RegExp(`\\b${r.from_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      out = out.replace(re, (match, offset, whole) => {
        const startsSentence = offset === 0 || /[.!?]\s*$/.test(whole.slice(0, offset));
        return startsSentence ? r.to_text[0].toUpperCase() + r.to_text.slice(1) : r.to_text;
      });
    }
  }
  if (rules.some(r => r.kind === 'no_exclaim')) out = out.replace(/!+/g, '.').replace(/\.\./g, '.');
  const sign = rules.find(r => r.kind === 'sign_off');
  if (sign && !/(?:^|\s)x{1,3}\s*$/i.test(out)) out = `${out.replace(/[.\s]+$/, '')} ${sign.value}`;
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function describeRule(r) {
  if (r.kind === 'replace') return { title: `“${r.to_text}” instead of “${r.from_text}”`, detail: 'From a caption you changed and approved.' };
  if (r.kind === 'no_exclaim') return { title: 'No exclamation marks', detail: 'You took them out of a caption you approved.' };
  if (r.kind === 'sign_off') return { title: `Sign off with “${r.value}”`, detail: 'You add it to the end of your captions.' };
  if (r.kind === 'max_hashtags') return { title: `No more than ${r.value} hashtags`, detail: 'You trimmed the rest.' };
  return { title: 'Writing preference', detail: '' };
}
