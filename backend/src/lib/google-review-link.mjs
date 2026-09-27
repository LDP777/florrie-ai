// Only direct Google review destinations. A review URL is not a Business Profile connection.
export function normaliseGoogleReviewLink(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'g.page' && /^\/r\/[\w-]+\/review\/?$/.test(url.pathname)) {
      return `https://g.page${url.pathname.replace(/\/$/, '')}`;
    }
    if (url.hostname === 'search.google.com' && url.pathname === '/local/writereview') {
      const id = url.searchParams.get('placeid');
      if (id && /^[\w-]{5,256}$/.test(id)) return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(id)}`;
    }
  } catch { /* Invalid or incomplete pasted link. */ }
  return null;
}

export function googleReviewLink(business) {
  const saved = normaliseGoogleReviewLink(business?.google_review_link);
  if (saved) return saved;
  const id = business?.google_place_id;
  return typeof id === 'string' && /^[\w-]{5,256}$/.test(id)
    ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(id)}` : null;
}
