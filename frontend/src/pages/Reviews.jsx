import { useState, useEffect } from 'react';
import { useBeautician, supabase, fetchRows, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Reviews & Reputation - track, respond to, and request client reviews.
 *
 * Features:
 *   - Google review aggregation with average rating
 *   - Review timeline with AI-drafted responses
 *   - Request review flow (auto-sends after completed appointment)
 *   - Reputation score tracking over time
 */

export default function Reviews() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('reviews');
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyText, setReplyText] = useState('');

  useEffect(() => {
    if (beautician && !bLoading) loadReviews();
  }, [beautician, bLoading]);

  async function loadReviews() {
    setLoading(true);
    try {
        // Fetch reviews from DB. The table stores `comment` + `response`; the UI
        // reads `text`/`reply`/`author`, so normalise here.
        const data = await fetchRows('reviews', beautician.id, { order: 'created_at', ascending: false });
        setReviews((data || []).map(r => ({
          ...r,
          author: r.author || r.client_name || 'Client',
          text: r.text || r.comment || '',
          reply: r.reply || r.response || '',
        })));
    } catch (err) {
      logger.error('Load reviews error:', err);
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }

  function startReply(review) {
    // AI-draft a response in Ellie's tone
    const drafts = {
      5: `Thank you so much ${review.author.split(' ')[0]}! So glad you love them 💕 Can't wait to see you again xx`,
      4: `Thanks lovely! Really appreciate you taking the time to leave a review 💕 See you next time xx`,
      3: `Thanks for your feedback ${review.author.split(' ')[0]}. I'd love to chat about how I can make your next visit even better - drop me a message xx`,
      2: `I'm sorry to hear that ${review.author.split(' ')[0]}. I really value your feedback and I'd love the chance to make it right. Please message me directly xx`,
      1: `I'm really sorry about your experience ${review.author.split(' ')[0]}. This isn't the standard I set for myself. Please reach out so I can put this right xx`,
    };
    setReplyText(drafts[review.rating] || drafts[3]);
    setReplyingTo(review.id);
  }

  const avgRating = reviews.length > 0
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : '0.0';
  const fiveStarPct = reviews.length > 0
    ? Math.round((reviews.filter(r => r.rating === 5).length / reviews.length) * 100)
    : 0;

  if (bLoading || loading) {
    return <PageLoader />;
  }

  return (
    <div style={styles.page}>
      <PageHeader title="Reviews" subtitle="Your Reputation" />

      {/* Rating hero */}
      <div style={styles.heroCard}>
        <div style={styles.heroLeft}>
          <span style={styles.heroRating}>{avgRating}</span>
          <div style={styles.heroStars}>
            {[1, 2, 3, 4, 5].map(i => (
              <span key={i} style={{ fontSize: 16, color: i <= Math.round(parseFloat(avgRating)) ? 'var(--warning, #D4943A)' : 'var(--text-muted, #B5AFA8)' }}>★</span>
            ))}
          </div>
          <span style={styles.heroCount}>{reviews.length} review{reviews.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={styles.heroRight}>
          <div style={styles.ratingBar}>
            <span style={styles.ratingBarLabel}>5★</span>
            <div style={styles.ratingBarTrack}>
              <div style={{ ...styles.ratingBarFill, width: `${fiveStarPct}%` }} />
            </div>
            <span style={styles.ratingBarPct}>{fiveStarPct}%</span>
          </div>
          {[4, 3, 2, 1].map(star => {
            const pct = reviews.length > 0
              ? Math.round((reviews.filter(r => r.rating === star).length / reviews.length) * 100)
              : 0;
            return (
              <div key={star} style={styles.ratingBar}>
                <span style={styles.ratingBarLabel}>{star}★</span>
                <div style={styles.ratingBarTrack}>
                  <div style={{ ...styles.ratingBarFill, width: `${pct}%`, background: star <= 2 ? 'var(--danger, #D4605C)' : star === 3 ? 'var(--warning, #D4943A)' : 'var(--success, #5BA97B)' }} />
                </div>
                <span style={styles.ratingBarPct}>{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {[
          { key: 'reviews', label: 'All Reviews' },
          { key: 'request', label: 'Request' },
          { key: 'settings', label: 'Auto-ask' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t.key ? 'var(--accent)' : 'transparent',
              color: tab === t.key ? 'var(--accent)' : '#AAA5A0',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Reviews list */}
      {tab === 'reviews' && (
        <div style={styles.body}>
          {reviews.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 36, display: 'block', marginBottom: 12 }}>⭐</span>
              <p style={styles.emptyTitle}>No reviews yet</p>
              <p style={styles.emptyDesc}>
                Connect your Google Business profile to pull in reviews, or start requesting them from clients.
              </p>
            </div>
          ) : (
            reviews.map(review => (
              <div key={review.id} style={styles.reviewCard}>
                <div style={styles.reviewHeader}>
                  <div style={styles.reviewAuthorRow}>
                    <div style={styles.reviewAvatar}>
                      {review.author[0].toUpperCase()}
                    </div>
                    <div>
                      <span style={styles.reviewAuthor}>{review.author}</span>
                      <span style={styles.reviewDate}>
                        {new Date(review.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                    </div>
                  </div>
                  <div style={styles.reviewStars}>
                    {[1, 2, 3, 4, 5].map(i => (
                      <span key={i} style={{ fontSize: 13, color: i <= review.rating ? 'var(--warning, #D4943A)' : 'var(--text-muted, #B5AFA8)' }}>★</span>
                    ))}
                  </div>
                </div>

                <p style={styles.reviewText}>{review.text}</p>

                {review.treatment && (
                  <span style={styles.reviewTreatment}>💅 {review.treatment}</span>
                )}

                {/* Reply section */}
                {review.reply ? (
                  <div style={styles.replyCard}>
                    <span style={styles.replyLabel}>Your reply</span>
                    <p style={styles.replyText}>{review.reply}</p>
                  </div>
                ) : replyingTo === review.id ? (
                  <div style={styles.replyForm}>
                    <span style={styles.replyDraftLabel}>🤖 AI-drafted reply</span>
                    <textarea
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      style={styles.replyTextarea}
                      rows={3}
                    />
                    <div style={styles.replyActions}>
                      <button
                        onClick={async () => {
                          const text = replyText;
                          try {
                            await updateRow('reviews', review.id, {
                              response: text,
                              responded_at: new Date().toISOString(),
                            });
                            setReviews(prev => prev.map(r =>
                              r.id === review.id ? { ...r, reply: text, response: text } : r
                            ));
                            setReplyingTo(null);
                          } catch (err) {
                            logger.error('Post reply error:', err);
                            alert('Could not save your reply. Please try again.');
                          }
                        }}
                        style={styles.replySubmitBtn}
                      >
                        Post Reply
                      </button>
                      <button onClick={() => setReplyingTo(null)} style={styles.replyCancelBtn}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => startReply(review)} style={styles.replyBtn}>
                    Reply
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Request tab */}
      {tab === 'request' && (
        <div style={styles.body}>
          <div style={styles.requestCard}>
            <span style={{ fontSize: 28, display: 'block', marginBottom: 8 }}>📱</span>
            <h3 style={styles.requestTitle}>Review requests are automatic</h3>
            <p style={styles.requestDesc}>
              florrie.ai sends a friendly review request 2 hours after each completed appointment, written in your voice. You don't need to do a thing.
            </p>

            <div style={styles.requestPreview}>
              <span style={styles.requestPreviewLabel}>Example message</span>
              <p style={styles.requestPreviewText}>
                "Hey lovely, thanks so much for coming in today! If you've got a sec, I'd really appreciate a quick Google review - it helps more than you'd think 💕 [link] xx"
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Auto-ask: how florrie.ai handles review requests. Read-only -
          these rules run on the backend and aren't editable yet, so they
          are shown as status, not as toggles that imply saved state. */}
      {tab === 'settings' && (
        <div style={styles.body}>
          <div style={styles.settingsCard}>
            <h4 style={styles.sectionLabel}>How florrie.ai asks for reviews</h4>
            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Auto-ask after appointments</span>
                <span style={styles.settingHint}>A review request goes out 2 hours after each completed appointment</span>
              </div>
              <span style={styles.settingValue}>On</span>
            </div>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Max requests per client</span>
                <span style={styles.settingHint}>The same client is not asked more than once every 3 months</span>
              </div>
              <span style={styles.settingValue}>1 per 90 days</span>
            </div>

            <div style={styles.settingRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.settingLabel}>Review platform</span>
                <span style={styles.settingHint}>Where clients are sent to leave a review</span>
              </div>
              <span style={styles.settingValue}>Google</span>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <h4 style={styles.sectionLabel}>Connect review platforms</h4>
            <p style={styles.settingHint}>Pulling reviews in from Google, Facebook and Treatwell is coming soon. For now, requests link clients to your Google review page.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg, #FAF8F5)', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text, #2D2A26)' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  // Hero card
  heroCard: {
    display: 'flex', gap: 16, background: 'var(--bg-card, #fff)', borderRadius: 14,
    padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 12,
  },
  heroLeft: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 80 },
  heroRating: { fontSize: 36, fontWeight: 700, color: 'var(--text, #2D2A26)', lineHeight: 1 },
  heroStars: { display: 'flex', gap: 1, marginTop: 4 },
  heroCount: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', marginTop: 4 },
  heroRight: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' },
  ratingBar: { display: 'flex', alignItems: 'center', gap: 6 },
  ratingBarLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', width: 22, textAlign: 'right' },
  ratingBarTrack: { flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-hover, #F5F2EF)', overflow: 'hidden' },
  ratingBarFill: { height: '100%', borderRadius: 3, background: 'var(--success, #5BA97B)', transition: 'width 0.3s ease' },
  ratingBarPct: { fontSize: 10, color: 'var(--text-muted, #B5AFA8)', width: 28, textAlign: 'right' },

  // Tabs
  tabs: { display: 'flex', gap: 24, borderBottom: '1px solid var(--border, #EDE9E4)', marginBottom: 16 },
  tab: { padding: '10px 0', background: 'none', border: 'none', borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  body: { display: 'flex', flexDirection: 'column', gap: 10 },

  // Review cards
  reviewCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  reviewHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  reviewAuthorRow: { display: 'flex', gap: 10, alignItems: 'center' },
  reviewAvatar: { width: 32, height: 32, borderRadius: 16, background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 },
  reviewAuthor: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  reviewDate: { display: 'block', fontSize: 10, color: 'var(--text-muted, #B5AFA8)', marginTop: 1 },
  reviewStars: { display: 'flex', gap: 1 },
  reviewText: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', margin: '0 0 8px', lineHeight: 1.5 },
  reviewTreatment: { display: 'inline-block', fontSize: 11, color: 'var(--text-secondary, #7A756F)', padding: '3px 8px', borderRadius: 6, background: 'var(--bg-hover, #F5F2EF)', marginBottom: 8 },
  replyCard: { background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 12, marginTop: 4 },
  replyLabel: { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  replyText: { fontSize: 12, color: 'var(--text-secondary, #7A756F)', margin: 0, lineHeight: 1.5 },
  replyBtn: { padding: '6px 14px', borderRadius: 8, border: '1.5px solid var(--border, #EDE9E4)', background: 'transparent', color: 'var(--accent, #C76B8A)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 },

  // Reply form
  replyForm: { background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 12, marginTop: 8 },
  replyDraftLabel: { display: 'block', fontSize: 11, color: 'var(--accent, #C76B8A)', fontWeight: 500, marginBottom: 6 },
  replyTextarea: { width: '100%', padding: 10, borderRadius: 8, border: '1.5px solid var(--border, #EDE9E4)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5, boxSizing: 'border-box' },
  replyActions: { display: 'flex', gap: 8, marginTop: 8 },
  replySubmitBtn: { flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  replyCancelBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--bg-hover, #F5F2EF)', color: 'var(--text-secondary, #7A756F)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },

  // Request tab
  requestCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 20, textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  requestTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  requestDesc: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', margin: '0 0 16px', lineHeight: 1.5 },
  requestPreview: { background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 12, marginBottom: 16, textAlign: 'left' },
  requestPreviewLabel: { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 },
  requestPreviewText: { fontSize: 12, color: 'var(--text-secondary, #7A756F)', margin: 0, lineHeight: 1.5, fontStyle: 'italic' },
  requestSendBtn: { padding: '12px 24px', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  requestHistoryCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  sectionLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 10px' },
  requestRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bg-hover, #F5F2EF)' },
  requestAvatar: { width: 28, height: 28, borderRadius: 14, background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 },
  requestName: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  requestMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #B5AFA8)' },
  requestStatusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },

  // Settings tab
  settingsCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  settingRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--bg-hover, #F5F2EF)' },
  settingLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  settingHint: { display: 'block', fontSize: 11, color: 'var(--text-muted, #B5AFA8)', marginTop: 2 },
  settingValue: { fontSize: 12, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0 },
  toggle: { width: 40, height: 24, borderRadius: 12, padding: 2, cursor: 'pointer', flexShrink: 0 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,0.15)', transition: 'transform 0.2s ease' },
  platformRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--bg-hover, #F5F2EF)' },
  platformName: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  platformBtn: { padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--bg-hover, #F5F2EF)', color: 'var(--text-secondary, #7A756F)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Empty
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #B5AFA8)', margin: 0, lineHeight: 1.5 },
};
