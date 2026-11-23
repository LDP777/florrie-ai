import { createGoogleReviews } from './google-reviews.js';

const captionFor = post => [post.caption, '', post.hashtags?.join(' ')].filter(Boolean).join('\n');
const googleDate = value => { const [year, month, day] = String(value).slice(0, 10).split('-').map(Number); return { year, month, day }; };

export function googlePostBody(post, offer) {
  const body = { languageCode: 'en-GB', summary: captionFor(post), topicType: offer ? 'OFFER' : 'STANDARD',
    callToAction: { actionType: 'BOOK', url: post.link_url },
    ...(post.image_url ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: post.image_url }] } : {}) };
  if (offer) {
    body.offer = { couponCode: offer.code, redeemOnlineUrl: post.link_url, termsConditions: offer.terms || '' };
    body.event = { title: offer.title || post.purpose?.title || 'Your salon offer', schedule: {
      startDate: googleDate(offer.appointments_from), endDate: googleDate(offer.appointments_to),
    } };
  }
  return body;
}

export function createGooglePosts({ db, fetchImpl = (...args) => fetch(...args), env = process.env, connection } = {}) {
  const account = connection || createGoogleReviews({ db, fetchImpl, env });
  const enabled = () => env.GOOGLE_POSTS_ENABLED === 'true';
  return {
    async status(owner) {
      if (!enabled()) return { available: false, connected: false, reason: 'Google posting is not enabled yet.' };
      return account.status(owner);
    },
    async recent(owner) {
      if (!enabled()) throw new Error('Google posting is not enabled yet.');
      const { access, location } = await account.publishingContext(owner);
      const posts = [];
      let token, complete = false;
      for (let page = 0; page < 5; page++) {
        const suffix = token ? `&pageToken=${encodeURIComponent(token)}` : '';
        const response = await fetchImpl(`https://mybusiness.googleapis.com/v4/${location}/localPosts?pageSize=100${suffix}`, {
          headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        if (!response.ok || (body.localPosts !== undefined && !Array.isArray(body.localPosts))) throw new Error('Google could not confirm this post. Florrie will check again.');
        posts.push(...(body.localPosts || []).map(post => ({ id: post.name, caption: post.summary, timestamp: post.createTime })));
        token = body.nextPageToken;
        complete = !token;
        if (complete) break;
      }
      return { posts, complete };
    },
    async publish(owner, post, beforePublish) {
      if (!enabled()) return { published: false, not_connected: true, reason: 'Google posting is not enabled yet. Your approval is safe.' };
      let context;
      try { context = await account.publishingContext(owner); }
      catch (error) { return { published: false, not_connected: true, reason: error.message }; }
      let offer;
      const promoId = post.claims?.find(claim => claim.kind === 'offer')?.promo_code_id;
      if (promoId) {
        const result = await db.from('promo_codes').select('*').eq('beautician_id', owner).eq('id', promoId).maybeSingle();
        if (result.error || !result.data?.marketing_approved_at) return { published: false, reason: 'Could not check your approved offer.' };
        offer = result.data;
      }
      await beforePublish();
      try {
        const response = await fetchImpl(`https://mybusiness.googleapis.com/v4/${context.location}/localPosts`, {
          method: 'POST', headers: { Authorization: `Bearer ${context.access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(googlePostBody(post, offer)), signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        if (response.ok && body.name) return { published: true, externalId: body.name };
        if (!response.ok && body.error) return { published: false, not_connected: response.status === 401,
          reason: body.error.message || 'Google could not publish this post.' };
        return { published: false, uncertain: true, reason: 'Florrie is checking the result with Google.' };
      } catch { return { published: false, uncertain: true, reason: 'Florrie is checking the result with Google.' }; }
    },
  };
}
