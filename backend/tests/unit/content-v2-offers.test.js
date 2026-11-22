import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { offerForMessaging, describePromo } from '../../src/lib/promos.js';
import { checkOfferClaims, safeReply } from '../../src/lib/reply-claims-guard.js';
import { contentLinkForMessage, renderContentReplyContext } from '../../src/services/content-post-context.js';

const promo = { id: 'offer-a', title: 'Christmas lashes', code: 'FESTIVE10', discount_type: 'fixed', discount_value: 1000,
  marketing_approved_at: '2026-11-20T12:00:00Z', is_active: true, valid_from: '2026-11-20T00:00:00Z', valid_until: '2026-12-20T23:59:59Z',
  appointments_from: '2026-12-01', appointments_to: '2026-12-24', treatment_ids: ['lash-a'], terms: 'One per client.',
  treatments: [{ id: 'lash-a', name: 'lash lift and tint', price_cents: 5000 }] };
const now = new Date('2026-12-01T12:00:00Z');
const offer = offerForMessaging(promo, { now });

describe('approved offers shared by Content and the front desk', () => {
  it('describes the exact discount, treatment, prices, appointment window, book-by, code and restriction', () => {
    expect(offer.client_reply).toBe("£10 off lash lift and tint for appointments 1 to 24 December. It's £40 instead of £50. Book by 20 December with code FESTIVE10. One per client.");
    expect(checkOfferClaims(offer.client_reply, [offer]).ok).toBe(true);
    expect(safeReply(offer.client_reply, { approvedOffers: [offer] }).rejected).toBe(false);
    expect(offer.prices).toEqual([{ treatment_id: 'lash-a', name: 'lash lift and tint', old_pence: 5000, new_pence: 4000 }]);
  });
  it('says the offer has finished on 21 December even while appointment dates remain', () => {
    const finished = offerForMessaging(promo, { now: new Date('2026-12-21T10:00:00Z') });
    expect(finished.active).toBe(false); expect(finished.client_reply).toBe('The Christmas lashes offer has finished.');
    expect(checkOfferClaims(finished.client_reply, [finished]).ok).toBe(true);
    expect(checkOfferClaims(offer.client_reply, [finished]).ok).toBe(false);
  });
  it.each([
    ['discount', '£10 off', '£20 off'], ['price', '£40 instead', '£30 instead'], ['appointment range', '24 December', '31 December'],
    ['deadline', 'Book by 20 December', 'Book by 24 December'], ['code', 'FESTIVE10', 'FREEBIES'], ['restriction', 'One per client.', ''],
  ])('holds a model reply that changes the approved %s', (_field, from, to) => {
    expect(safeReply(offer.client_reply.replace(from, to), { approvedOffers: [offer] }).rejected).toBe(true);
  });
  it('holds extra prices or widened dates appended after otherwise correct terms', () => {
    expect(checkOfferClaims(`${offer.client_reply} I can make it £25.`, [offer]).ok).toBe(false);
    expect(checkOfferClaims(`${offer.client_reply} Extended until 31 December.`, [offer]).ok).toBe(false);
    expect(checkOfferClaims(`${offer.client_reply} This runs next month too.`, [offer]).ok).toBe(false);
    expect(checkOfferClaims(`${offer.client_reply} You can also use code FREEBIES.`, [offer]).ok).toBe(false);
    expect(checkOfferClaims(`${offer.client_reply} You can use it twice.`, [offer]).ok).toBe(false);
  });
  it('does not confuse different offers sharing the same deadline and restriction', () => {
    const other = offerForMessaging({ ...promo, id: 'other-offer', title: 'Christmas brows', code: 'BROWS5', discount_value: 500,
      treatments: [{ id: 'brow-a', name: 'brow tint', price_cents: 2000 }] }, { now });
    expect(checkOfferClaims(offer.client_reply, [offer, other]).ok).toBe(true);
    expect(checkOfferClaims(other.client_reply, [offer, other]).ok).toBe(true);
  });
  it('allows ordinary treatment information and an honest no-offer reply', () => {
    expect(checkOfferClaims('A lash lift and tint is £50.', []).ok).toBe(true);
    expect(checkOfferClaims('I can offer Thursday at 4pm.', []).ok).toBe(true);
    expect(checkOfferClaims('There are no offers running right now.', []).ok).toBe(true);
    expect(checkOfferClaims('You can have £10 off today.', []).ok).toBe(false);
  });
  it('honours exact booking validity instants within the same day', () => {
    expect(offerForMessaging({ ...promo, valid_from: '2026-12-01T18:00:00Z' }, { now }).active).toBe(false);
    expect(offerForMessaging({ ...promo, valid_until: '2026-12-01T10:00:00Z' }, { now }).finished).toBe(true);
  });
  it('does not market a code the owner has not approved, and preserves legacy descriptions', () => {
    expect(offerForMessaging({ ...promo, marketing_approved_at: null }, { now })).toBeNull();
    expect(describePromo({ code: 'HELLO', discount_type: 'percentage', discount_value: 10 })).toBe('10% off with code HELLO');
  });
  it('uses a specific post link only when the message identifies a unique post or offer', () => {
    const posts = [{ title: 'Thursday has space', link_url: 'https://fictional.example/book?fl_content=thursday' },
      { title: 'Festive lash lift', offer_id: 'offer-a', link_url: 'https://fictional.example/book?fl_content=christmas' }];
    expect(contentLinkForMessage('I saw your post about Thursday', posts, [offer])).toBe(posts[0].link_url);
    expect(contentLinkForMessage('do you have any christmas offers?', posts, [offer])).toBe(posts[1].link_url);
    expect(contentLinkForMessage('Hello!', posts, [offer])).toBeNull();
    expect(contentLinkForMessage('I saw your post', posts, [offer])).toBeNull();
  });
  it('gives the front desk the same full reply and prohibits promises based on an old post', () => {
    const prompt = renderContentReplyContext({ approvedOffers: [offer], recentPosts: [], contentLink: null });
    expect(prompt).toContain(offer.client_reply); expect(prompt).toContain('Never extend a date or discount');
    expect(prompt).toContain('not evidence of current availability');
  });
});
