import { supabase } from '../config.js';
import logger from '../lib/logger.js';

export async function recentContentForMessaging(owner, { db = supabase, now = new Date() } = {}) {
  const result = await db.from('content_posts').select('id,purpose,claims,link_url,posted_at,external_post_id,published_by_owner,post_type')
    .eq('beautician_id', owner).eq('status', 'posted').gte('posted_at', new Date(now.getTime() - 14 * 86400000).toISOString())
    .order('posted_at', { ascending: false }).limit(20);
  if (result.error) { logger.warn({ err: result.error, owner }, 'Recent content could not be read for a client reply'); return []; }
  return (result.data || []).filter(post => post.post_type !== 'gallery' && (post.external_post_id || post.published_by_owner))
    .map(post => ({ id: post.id, title: post.purpose?.title || 'Salon post', facts: (post.claims || []).map(claim => claim.text),
      offer_id: post.claims?.find(claim => claim.kind === 'offer')?.promo_code_id, link_url: post.link_url, posted_at: post.posted_at }));
}

export function contentLinkForMessage(text, posts = [], offers = []) {
  const body = String(text || '').toLowerCase();
  if (!/\b(?:posts?|instagram|saw|offers?|deals?|discount|code)\b/.test(body)) return null;
  const terms = body.match(/[a-z0-9]+/g) || [];
  const ignored = new Set(['post', 'instagram', 'your', 'about', 'offer', 'offers', 'have', 'this', 'that', 'with', 'there', 'what']);
  const scored = posts.filter(post => /^https:\/\//.test(post.link_url || '')).map(post => {
    const offer = offers.find(item => item.id === post.offer_id);
    const title = `${post.title} ${offer?.title || ''} ${offer?.code || ''}`.toLowerCase();
    return { post, score: terms.filter(term => term.length > 2 && !ignored.has(term) && title.includes(term)).length };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
  return scored[0].post.link_url;
}

export function renderContentReplyContext(context) {
  const offers = context.approvedOffers;
  const instructions = offers === undefined ? '' : `APPROVED OFFER TERMS: ${offers.map(offer => offer.client_reply).filter(Boolean).join(' ') || 'No approved offers are available.'}
Quote the approved terms exactly when answering an offer question, including treatment, discount, old and new price, appointment dates, book-by date, code and restrictions. Never extend a date or discount. An offer marked finished has finished, even if its appointment window has days left. Say it has finished. A post is not evidence of current availability; use the verified free slots.`;
  const recent = context.recentPosts?.length ? `RECENT POSTS: ${JSON.stringify(context.recentPosts)}. These are context only. Check the diary before promising a time.` : '';
  const link = context.contentLink ? `For this specific post or offer use its own booking link: ${context.contentLink}` : '';
  return [instructions, recent, link].filter(Boolean).join('\n');
}

export function includeContentLink(text, context) {
  return context.contentLink && !String(text).includes(context.contentLink) ? `${text}\n${context.contentLink}` : text;
}
