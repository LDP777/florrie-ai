import { describe, expect, it } from 'vitest';
import { googleReviewLink, normaliseGoogleReviewLink } from '../../src/lib/google-review-link.mjs';

describe('Google review destinations', () => {
  it('accepts the link Google supplies and removes tracking parameters', () => {
    expect(normaliseGoogleReviewLink(' https://g.page/r/CX_test-1/review?rc ')).toBe('https://g.page/r/CX_test-1/review');
    expect(normaliseGoogleReviewLink('https://search.google.com/local/writereview?placeid=ChIJ_salon')).toBe('https://search.google.com/local/writereview?placeid=ChIJ_salon');
  });
  it.each(['https://g.page.evil.test/r/id/review','https://g.page@evil.test/r/id/review','http://g.page/r/id/review','javascript:alert(1)','https://g.page/r/id','https://search.google.com/local/writereview?placeid=','https://search.google.com/redirect?url=evil','https://g.page:444/r/id/review'])('rejects non-review destination %s', value => {
    expect(normaliseGoogleReviewLink(value)).toBeNull();
  });
  it('prefers a saved link, retains the existing place ID and never creates an empty review URL', () => {
    expect(googleReviewLink({ google_review_link:'https://g.page/r/salon/review', google_place_id:'oldPlace' })).toBe('https://g.page/r/salon/review');
    expect(googleReviewLink({ google_place_id:'ChIJ_salon' })).toContain('placeid=ChIJ_salon');
    expect(googleReviewLink({})).toBeNull();
    expect(googleReviewLink({ google_place_id:'wrong&url=evil' })).toBeNull();
  });
});
