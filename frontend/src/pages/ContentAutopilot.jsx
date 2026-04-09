import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows, insertRow, updateRow, deleteRow, DEV_TREATMENTS } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token — find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Content Autopilot — Ellie's #1 pain point.
 *
 * Three tabs:
 *   Ideas   — template captions grouped by type, one-tap to draft
 *   Drafts  — posts waiting for approval (edit, approve, discard)
 *   Posted  — published posts with engagement stats
 *
 * Quick-post flow:
 *   Pick type → write or use template → optional photo → save draft → approve
 *
 * Caption generation calls the backend when available;
 * template-based fallback always works offline.
 */

// ── Caption templates (Ellie's tone: warm, casual, 1-2 sentences, xx) ──

const CAPTION_TEMPLATES = {
  before_after: [
    "Cannot get over this set {treatment} — the definition is unreal. DM me to book yours {emoji}",
    "Before ➡️ After. This is why I love what I do. {treatment} looking fresh {emoji}",
    "Happy Friday with this gorgeous {treatment} glow-up. Slots going fast for next week, grab one {emoji}",
    "Obsessed isn't even the word. {treatment} results that speak for themselves {emoji}",
    "That crisp, fluffy finish {emoji} Love a good {treatment} transformation. DM to book xx",
    "Before and after a {treatment} session — she left buzzing and honestly same {emoji}",
  ],
  last_minute_availability: [
    "Gap alert {emoji} I've had a cancellation on {day} — who wants it? DM me quick xx",
    "Last minute slot just opened up {day} afternoon. Perfect for a {treatment}. First to DM gets it {emoji}",
    "Cancellation = your lucky day {emoji} {day} is free. Grab it before it goes xx",
    "Unexpected gap on {day}! If you've been putting off rebooking, this is your sign {emoji} DM me xx",
  ],
  promotion: [
    "Treat yourself this week — {offer}. Book via DM or the link in my bio {emoji}",
    "Something special for my regulars {emoji} {offer}. Limited slots, don't sleep on it xx",
    "{offer} — because you deserve it {emoji} DM to book xx",
  ],
  testimonial: [
    "When your client sends you this {emoji} Best feeling ever. If you want results like this, you know where I am xx",
    "Client love is the best kind of love {emoji} Thank you for trusting me with your {treatment} xx",
    "Reviews like this make my whole week {emoji} If you've been thinking about booking, this is your sign xx",
  ],
  general: [
    "Morning from the studio {emoji} Ready for a full day of gorgeous {treatment} bookings. Love this job xx",
    "New week, fresh brows {emoji} Let's get you booked in. Link in bio or DM me xx",
    "That feeling when every slot this week is full {emoji} If you want in next week, book now — they go fast xx",
  ],
};

const EMOJIS = ['✨', '💫', '🤍', '🫶', '💕', '👏'];
const POST_TYPE_LABELS = {
  before_after: 'Before/After',
  last_minute_availability: 'Availability Drop',
  promotion: 'Offer / Promo',
  testimonial: 'Client Love',
  general: 'General',
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template, vars) {
  let result = template;
  Object.entries(vars).forEach(([k, v]) => {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  });
  return result;
}

// ── Default hashtag sets by category ──
const DEFAULT_HASHTAGS = {
  brows: ['#brows', '#browlamination', '#browspecialist', '#browgoals', '#browsonfleek', '#beautysalon'],
  lashes: ['#lashes', '#lashlift', '#lashlifttint', '#lashgoals', '#lashspecialist', '#beautysalon'],
  other: ['#beauty', '#beautysalon', '#treatyourself', '#selfcare', '#beautytreatment'],
};

export default function ContentAutopilot() {
  const { beautician, loading: bLoading } = useBeautician();
  const [drafts, setDrafts] = useState([]);
  const [posted, setPosted] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('ideas');
  const [publishing, setPublishing] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editCaption, setEditCaption] = useState('');

  // AI suggestions (from recent appointments)
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // AI caption generation in compose
  const [generatingAI, setGeneratingAI] = useState(false);

  // Gallery (before/after)
  const [gallery, setGallery] = useState([]);
  const [showGalleryAdd, setShowGalleryAdd] = useState(false);
  const [galleryForm, setGalleryForm] = useState({ treatment: '', notes: '' });
  const [galleryBefore, setGalleryBefore] = useState(null);
  const [galleryAfter, setGalleryAfter] = useState(null);
  const [galleryBeforePreview, setGalleryBeforePreview] = useState(null);
  const [galleryAfterPreview, setGalleryAfterPreview] = useState(null);
  const [savingGallery, setSavingGallery] = useState(false);
  const beforeRef = useRef(null);
  const afterRef = useRef(null);

  // Compose mode
  const [composing, setComposing] = useState(false);
  const [composeType, setComposeType] = useState('before_after');
  const [composeCaption, setComposeCaption] = useState('');
  const [composeHashtags, setComposeHashtags] = useState('');
  const [composeImageFile, setComposeImageFile] = useState(null);
  const [composeImagePreview, setComposeImagePreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  // Treatments for template fill
  const [treatments, setTreatments] = useState([]);

  useEffect(() => {
    if (beautician) {
      loadAll();
      loadTreatments();
      loadGallery();
      loadSuggestions();
    }
  }, [beautician]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      if (isDevMode) {
        setDrafts(DEV_DRAFTS);
        setPosted([]);
        setLoading(false);
        return;
      }
      const [d, p] = await Promise.all([
        fetchRows('content_posts', beautician.id, { eq: { status: 'draft' }, order: 'created_at', ascending: false }),
        fetchRows('content_posts', beautician.id, { eq: { status: 'posted' }, order: 'posted_at', ascending: false }),
      ]);
      setDrafts(d);
      setPosted(p);
    } catch (err) {
      logger.error('Load content error:', err);
      setError(err.message || 'Failed to load content');
    } finally {
      setLoading(false);
    }
  }

  async function loadTreatments() {
    if (isDevMode) { setTreatments(DEV_TREATMENTS); return; }
    const data = await fetchRows('treatments', beautician.id, { eq: { is_active: true } });
    setTreatments(data);
  }

  async function loadSuggestions() {
    if (isDevMode) return;
    setLoadingSuggestions(true);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/content/suggestions`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch (err) {
      logger.warn('Suggestions load failed:', err);
    } finally {
      setLoadingSuggestions(false);
    }
  }

  async function handleAIWrite() {
    if (!beautician || generatingAI) return;
    setGeneratingAI(true);
    try {
      const token = getToken();
      const treatmentName = treatments.length > 0 ? pickRandom(treatments).name : null;
      const res = await fetch(`${API_BASE}/api/content/caption`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          post_type: composeType,
          treatment_type: treatmentName,
        }),
      });
      if (!res.ok) throw new Error('AI write failed');
      const data = await res.json();
      if (data.caption) setComposeCaption(data.caption);
      if (data.hashtags?.length) setComposeHashtags(data.hashtags.join(' '));
    } catch (err) {
      logger.warn('AI write failed, falling back to template:', err);
      setComposeCaption(getFilledTemplate(composeType));
    } finally {
      setGeneratingAI(false);
    }
  }

  // ── Gallery helpers ──

  async function loadGallery() {
    if (isDevMode) {
      setGallery(DEV_GALLERY);
      return;
    }
    // Gallery items stored as content_posts with post_type='gallery'
    try {
      const data = await fetchRows('content_posts', beautician.id, {
        eq: { post_type: 'gallery' },
        order: 'created_at',
        ascending: false,
      });
      setGallery(data);
    } catch (err) {
      logger.error('Load gallery:', err);
    }
  }

  function handleGalleryImage(which, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (which === 'before') { setGalleryBefore(file); setGalleryBeforePreview(url); }
    else { setGalleryAfter(file); setGalleryAfterPreview(url); }
  }

  async function handleSaveGalleryItem() {
    if (!galleryBefore || !galleryAfter) return;
    setSavingGallery(true);
    try {
      let beforeUrl = galleryBeforePreview;
      let afterUrl = galleryAfterPreview;

      // Upload images in production
      if (supabase && beautician) {
        for (const [file, label] of [[galleryBefore, 'before'], [galleryAfter, 'after']]) {
          const ext = file.name.split('.').pop();
          const path = `${beautician.id}/gallery/${Date.now()}-${label}.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('content-images')
            .upload(path, file, { contentType: file.type });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('content-images').getPublicUrl(path);
            if (label === 'before') beforeUrl = urlData?.publicUrl;
            else afterUrl = urlData?.publicUrl;
          }
        }
      }

      const item = {
        id: crypto.randomUUID(),
        post_type: 'gallery',
        before_url: beforeUrl,
        after_url: afterUrl,
        treatment_name: galleryForm.treatment || 'Treatment',
        caption: galleryForm.notes,
        created_at: new Date().toISOString(),
      };

      if (!isDevMode) {
        await insertRow('content_posts', {
          beautician_id: beautician.id,
          post_type: 'gallery',
          image_url: afterUrl,
          caption: `Before/After: ${galleryForm.treatment}${galleryForm.notes ? ' — ' + galleryForm.notes : ''}`,
          status: 'draft',
        });
      }

      setGallery(prev => [item, ...prev]);
      setShowGalleryAdd(false);
      setGalleryForm({ treatment: '', notes: '' });
      setGalleryBefore(null);
      setGalleryAfter(null);
      setGalleryBeforePreview(null);
      setGalleryAfterPreview(null);
    } catch (err) {
      logger.error('Save gallery:', err);
    }
    setSavingGallery(false);
  }

  // ── Compose helpers ──

  function startCompose(type, prefillCaption) {
    setComposeType(type);
    setComposeCaption(prefillCaption || '');
    const category = treatments[0]?.category || 'brows';
    setComposeHashtags((DEFAULT_HASHTAGS[category] || DEFAULT_HASHTAGS.other).join(' '));
    setComposeImageFile(null);
    setComposeImagePreview(null);
    setComposing(true);
    setTab('compose');
  }

  function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setComposeImageFile(file);
    setComposeImagePreview(URL.createObjectURL(file));
  }

  async function handleSaveDraft() {
    if (!composeCaption.trim() || !beautician) return;
    setSaving(true);
    try {
      let imageUrl = null;

      // Upload image to Supabase Storage if available
      if (composeImageFile && supabase) {
        const ext = composeImageFile.name.split('.').pop();
        const path = `${beautician.id}/${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('content-images')
          .upload(path, composeImageFile, { contentType: composeImageFile.type });

        if (!uploadErr) {
          const { data: urlData } = supabase.storage.from('content-images').getPublicUrl(path);
          imageUrl = urlData?.publicUrl || null;
        } else {
          logger.warn('Image upload failed:', uploadErr.message);
        }
      }

      const hashtags = composeHashtags.trim().split(/\s+/).filter(h => h.startsWith('#'));

      const post = await insertRow('content_posts', {
        beautician_id: beautician.id,
        caption: composeCaption.trim(),
        hashtags,
        image_url: imageUrl,
        platform: 'instagram',
        post_type: composeType,
        status: 'draft',
      });

      setDrafts(prev => [post, ...prev]);
      setComposing(false);
      setTab('drafts');
    } catch (err) {
      logger.error('Save draft error:', err);
    } finally {
      setSaving(false);
    }
  }

  // ── Draft actions ──

  async function handleApprove(postId) {
    setPublishing(postId);
    try {
      if (isDevMode) {
        // Dev mode: just move locally
        setDrafts(prev => prev.filter(p => p.id !== postId));
        setPublishing(null);
        return;
      }

      // Call backend publish endpoint — handles Instagram Graph API if connected
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/content/${postId}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Publish failed');

      setDrafts(prev => prev.filter(p => p.id !== postId));

      // Reload posted
      const p = await fetchRows('content_posts', beautician.id, { eq: { status: 'posted' }, order: 'posted_at', ascending: false });
      setPosted(p);

      if (result.published) {
        logger.info('Post published to Instagram', result.instagramId);
      } else {
        logger.info('Post approved (Instagram not connected)', result.reason);
      }
    } catch (err) {
      logger.error('Approve error:', err);
    } finally {
      setPublishing(null);
    }
  }

  async function handleEditSave(postId) {
    try {
      await updateRow('content_posts', postId, { caption: editCaption });
      setDrafts(prev => prev.map(p => p.id === postId ? { ...p, caption: editCaption } : p));
      setEditingId(null);
    } catch (err) {
      logger.error('Edit error:', err);
    }
  }

  async function handleDiscard(postId) {
    try {
      await deleteRow('content_posts', postId);
      setDrafts(prev => prev.filter(p => p.id !== postId));
    } catch (err) {
      logger.error('Discard error:', err);
    }
  }

  // ── Template fill ──

  function getFilledTemplate(type) {
    const templates = CAPTION_TEMPLATES[type] || CAPTION_TEMPLATES.general;
    const template = pickRandom(templates);
    const treatmentName = treatments.length > 0
      ? pickRandom(treatments).name.toLowerCase()
      : 'brow treatment';
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    return fillTemplate(template, {
      treatment: treatmentName,
      emoji: pickRandom(EMOJIS),
      day: pickRandom(dayNames),
      offer: '10% off all lamination this week',
    });
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  return (
    <div style={styles.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Florrie Content</h1>
          <p style={styles.subtitle}>Florrie writes your captions and posts</p>
        </div>
        <button onClick={() => startCompose('before_after', '')} style={styles.uploadBtn}>
          + New Post
        </button>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {['ideas', 'drafts', 'posted', 'gallery'].map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setComposing(false); }}
            style={{
              ...styles.tab,
              borderBottomColor: (tab === t || (tab === 'compose' && t === 'drafts')) ? 'var(--accent, #C76B8A)' : 'transparent',
              color: (tab === t || (tab === 'compose' && t === 'drafts')) ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #7a7470)'
            }}
          >
            {t === 'ideas' ? 'Ideas' : t === 'drafts' ? `Drafts${drafts.length ? ` (${drafts.length})` : ''}` : t === 'posted' ? 'Posted' : 'Gallery'}
          </button>
        ))}
      </div>

      {/* ═══ IDEAS TAB ═══ */}
      {tab === 'ideas' && (
        <div style={styles.postList}>
          {/* AI suggestions — from recent appointments */}
          {(loadingSuggestions || suggestions.length > 0) && (
            <div style={styles.aiSuggestionsSection}>
              <div style={styles.aiSuggestionsHeader}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent, #C76B8A)' }}>✨ From your recent clients</span>
                <button onClick={loadSuggestions} style={styles.refreshBtn} disabled={loadingSuggestions}>
                  {loadingSuggestions ? '...' : '↻'}
                </button>
              </div>
              {loadingSuggestions ? (
                <div style={styles.aiLoadingCard}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #7a7470)' }}>Florrie is writing ideas from your recent appointments...</span>
                </div>
              ) : suggestions.map(s => (
                <div key={s.id} style={styles.aiSuggestionCard} onClick={() => startCompose(s.treatment_type?.includes('avail') ? 'last_minute_availability' : 'before_after', s.caption)}>
                  <span style={styles.aiSuggestionTreatment}>{s.treatment_type}</span>
                  <p style={styles.aiSuggestionCaption}>{s.caption}</p>
                  <span style={styles.ideaTap}>Tap to use</span>
                </div>
              ))}
            </div>
          )}

          <p style={styles.ideaIntro}>
            Tap any idea to customise and save as a draft. Fresh templates every time.
          </p>

          {Object.entries(POST_TYPE_LABELS).map(([type, label]) => (
            <div key={type} style={styles.ideaGroup}>
              <div style={styles.ideaGroupHeader}>
                <span style={styles.ideaGroupLabel}>{label}</span>
              </div>
              <div style={styles.ideaCard} onClick={() => startCompose(type, getFilledTemplate(type))}>
                <p style={styles.ideaCaption}>{getFilledTemplate(type)}</p>
                <span style={styles.ideaTap}>Tap to use</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ COMPOSE VIEW ═══ */}
      {tab === 'compose' && composing && (
        <div style={styles.composeArea}>
          <div style={styles.composeTypeRow}>
            {Object.entries(POST_TYPE_LABELS).map(([type, label]) => (
              <button
                key={type}
                onClick={() => setComposeType(type)}
                style={{
                  ...styles.composeTypeBtn,
                  background: composeType === type ? '#FBF0F3' : 'var(--bg-subtle, var(--bg-subtle, #F5F2EF))',
                  color: composeType === type ? 'var(--accent, #C76B8A)' : '#6b6560',
                  fontWeight: composeType === type ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Photo */}
          <div
            style={styles.photoArea}
            onClick={() => fileRef.current?.click()}
          >
            {composeImagePreview ? (
              <img src={composeImagePreview} alt="" style={styles.previewImg} />
            ) : (
              <div style={styles.photoPlaceholder}>
                <span style={{ fontSize: 28 }}>📸</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted, #7a7470)' }}>Add photo (optional)</span>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              style={{ display: 'none' }}
            />
          </div>

          {/* Caption */}
          <textarea
            value={composeCaption}
            onChange={e => setComposeCaption(e.target.value)}
            placeholder="Write your caption..."
            style={styles.composeTextarea}
            rows={4}
          />

          {/* Caption tools row */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setComposeCaption(getFilledTemplate(composeType))}
              style={{ ...styles.shuffleBtn, flex: 1 }}
            >
              Shuffle
            </button>
            <button
              onClick={handleAIWrite}
              disabled={generatingAI}
              style={{
                ...styles.shuffleBtn,
                flex: 2,
                background: 'linear-gradient(135deg, #FBF0F3, #F3EEFF)',
                color: 'var(--accent, #C76B8A)',
                fontWeight: 600,
                opacity: generatingAI ? 0.7 : 1,
              }}
            >
              {generatingAI ? 'Writing...' : '✨ Write with AI'}
            </button>
          </div>

          {/* Hashtags */}
          <input
            value={composeHashtags}
            onChange={e => setComposeHashtags(e.target.value)}
            placeholder="#brows #beauty #browlamination"
            style={styles.hashtagInput}
          />

          {/* Actions */}
          <div style={styles.composeActions}>
            <button
              onClick={handleSaveDraft}
              disabled={!composeCaption.trim() || saving}
              style={{
                ...styles.primaryBtn,
                opacity: !composeCaption.trim() ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save as Draft'}
            </button>
            <button onClick={() => { setComposing(false); setTab('ideas'); }} style={styles.cancelBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ═══ DRAFTS TAB ═══ */}
      {tab === 'drafts' && !composing && (
        <div style={styles.postList}>
          {drafts.length === 0 && !loading && (
            <EmptyState
              icon="📸"
              title="No drafts waiting"
              subtitle="Head to Ideas to pick a template, or tap + New Post to start from scratch."
            />
          )}

          {drafts.map(post => (
            <div key={post.id} style={styles.postCard}>
              {/* Type badge */}
              <div style={{
                ...styles.typeBadge,
                background: post.post_type === 'last_minute_availability' ? '#FEF3C7' : '#FBF0F3',
                color: post.post_type === 'last_minute_availability' ? '#B45309' : 'var(--accent, #C76B8A)'
              }}>
                {POST_TYPE_LABELS[post.post_type] || 'Post'}
              </div>

              {/* Image */}
              {post.image_url && (
                <div style={styles.imageContainer}>
                  <img src={post.image_url} alt="" style={styles.postImage} />
                </div>
              )}

              {/* Caption */}
              {editingId === post.id ? (
                <div style={styles.editArea}>
                  <textarea
                    value={editCaption}
                    onChange={e => setEditCaption(e.target.value)}
                    style={styles.editTextarea}
                    rows={4}
                    autoFocus
                  />
                  <div style={styles.editActions}>
                    <button onClick={() => handleEditSave(post.id)} style={styles.saveEditBtn}>Save</button>
                    <button onClick={() => setEditingId(null)} style={styles.cancelEditBtn}>Cancel</button>
                  </div>
                </div>
              ) : (
                <p style={styles.caption}>{post.caption}</p>
              )}

              {/* Hashtags */}
              {post.hashtags?.length > 0 && (
                <div style={styles.hashtags}>
                  {post.hashtags.map(h => (
                    <span key={h} style={styles.hashtag}>{h}</span>
                  ))}
                </div>
              )}

              {/* Actions */}
              {editingId !== post.id && (
                <div style={styles.actions}>
                  <button
                    onClick={() => handleApprove(post.id)}
                    disabled={publishing === post.id}
                    style={styles.publishBtn}
                  >
                    {publishing === post.id ? 'Posting...' : 'Approve & Post'}
                  </button>
                  <button
                    onClick={() => { setEditingId(post.id); setEditCaption(post.caption || ''); }}
                    style={styles.editBtn}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDiscard(post.id)}
                    style={styles.discardBtn}
                  >
                    Discard
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ═══ POSTED TAB ═══ */}
      {tab === 'posted' && (
        <div style={styles.postList}>
          {posted.length === 0 && (
            <EmptyState
              icon="🎉"
              title="Nothing posted yet"
              subtitle="Approved posts will appear here with engagement stats once Instagram is connected."
            />
          )}

          {posted.map(post => (
            <div key={post.id} style={styles.postCard}>
              {post.image_url && (
                <div style={styles.imageContainer}>
                  <img src={post.image_url} alt="" style={styles.postImage} />
                </div>
              )}
              <p style={styles.caption}>{post.caption}</p>

              {/* Engagement stats */}
              <div style={styles.statsRow}>
                <div style={styles.stat}>
                  <span style={styles.statNum}>{post.likes || 0}</span>
                  <span style={styles.statLabel}>Likes</span>
                </div>
                <div style={styles.stat}>
                  <span style={styles.statNum}>{post.comments || 0}</span>
                  <span style={styles.statLabel}>Comments</span>
                </div>
                <div style={styles.stat}>
                  <span style={styles.statNum}>{post.bookings_attributed || 0}</span>
                  <span style={styles.statLabel}>Bookings</span>
                </div>
              </div>

              <span style={styles.postedDate}>
                Posted {new Date(post.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ═══ GALLERY TAB ═══ */}
      {tab === 'gallery' && (
        <div style={styles.postList}>
          <div style={styles.galleryHeaderRow}>
            <p style={styles.ideaIntro}>
              Before & after photos. Your best portfolio — clients love seeing results.
            </p>
            <button onClick={() => setShowGalleryAdd(true)} style={styles.galleryAddBtn}>+ Add</button>
          </div>

          {/* Add form */}
          {showGalleryAdd && (
            <div style={styles.galleryAddCard}>
              <div style={styles.galleryPhotoPair}>
                <div style={styles.galleryPhotoSlot} onClick={() => beforeRef.current?.click()}>
                  {galleryBeforePreview ? (
                    <img src={galleryBeforePreview} alt="Before" style={styles.galleryThumb} />
                  ) : (
                    <div style={styles.galleryPlaceholder}>
                      <span style={{ fontSize: 20 }}>📷</span>
                      <span style={styles.galleryPlaceholderText}>Before</span>
                    </div>
                  )}
                  <input ref={beforeRef} type="file" accept="image/*" onChange={e => handleGalleryImage('before', e)} style={{ display: 'none' }} />
                </div>
                <span style={styles.galleryArrow}>→</span>
                <div style={styles.galleryPhotoSlot} onClick={() => afterRef.current?.click()}>
                  {galleryAfterPreview ? (
                    <img src={galleryAfterPreview} alt="After" style={styles.galleryThumb} />
                  ) : (
                    <div style={styles.galleryPlaceholder}>
                      <span style={{ fontSize: 20 }}>✨</span>
                      <span style={styles.galleryPlaceholderText}>After</span>
                    </div>
                  )}
                  <input ref={afterRef} type="file" accept="image/*" onChange={e => handleGalleryImage('after', e)} style={{ display: 'none' }} />
                </div>
              </div>

              <select
                value={galleryForm.treatment}
                onChange={e => setGalleryForm(f => ({ ...f, treatment: e.target.value }))}
                style={styles.gallerySelect}
              >
                <option value="">Select treatment</option>
                {treatments.map(t => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>

              <input
                value={galleryForm.notes}
                onChange={e => setGalleryForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Notes (optional) e.g. First-time client"
                style={styles.galleryNotesInput}
              />

              <div style={styles.galleryFormActions}>
                <button
                  onClick={handleSaveGalleryItem}
                  disabled={!galleryBefore || !galleryAfter || savingGallery}
                  style={{
                    ...styles.primaryBtn,
                    opacity: (!galleryBefore || !galleryAfter) ? 0.5 : 1,
                  }}
                >
                  {savingGallery ? 'Saving...' : 'Save to Gallery'}
                </button>
                <button onClick={() => {
                  setShowGalleryAdd(false);
                  setGalleryBefore(null);
                  setGalleryAfter(null);
                  setGalleryBeforePreview(null);
                  setGalleryAfterPreview(null);
                }} style={styles.cancelBtn}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Gallery grid */}
          {gallery.length === 0 && !showGalleryAdd && (
            <EmptyState
              icon="📸"
              title="No before/after photos yet"
              subtitle="Add your best transformations. These build trust and help clients see what you can do."
            />
          )}

          {gallery.map(item => (
            <div key={item.id} style={styles.galleryCard}>
              <div style={styles.galleryPhotoPairView}>
                <div style={styles.galleryPhotoView}>
                  <img src={item.before_url} alt="Before" style={styles.galleryViewImg} />
                  <span style={styles.galleryLabel}>Before</span>
                </div>
                <div style={styles.galleryPhotoView}>
                  <img src={item.after_url} alt="After" style={styles.galleryViewImg} />
                  <span style={styles.galleryLabel}>After</span>
                </div>
              </div>
              <div style={styles.galleryCardFooter}>
                <span style={styles.galleryTreatmentName}>{item.treatment_name}</span>
                {item.caption && <span style={styles.galleryCaption}>{item.caption}</span>}
                <span style={styles.galleryDate}>
                  {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Dev mode gallery items ──
const DEV_GALLERY = [
  {
    id: 'dev-gal-1',
    before_url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23F0ECE8" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23AAA5A0" font-size="14"%3EBefore%3C/text%3E%3C/svg%3E',
    after_url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23FBF0F3" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23C76B8A" font-size="14"%3EAfter%3C/text%3E%3C/svg%3E',
    treatment_name: 'Lamination & Hybrid Dye',
    caption: 'First-time client — blown away by the result',
    created_at: '2026-03-22T14:00:00Z',
  },
  {
    id: 'dev-gal-2',
    before_url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23F0ECE8" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23AAA5A0" font-size="14"%3EBefore%3C/text%3E%3C/svg%3E',
    after_url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23FBF0F3" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23C76B8A" font-size="14"%3EAfter%3C/text%3E%3C/svg%3E',
    treatment_name: 'Ombre Brows',
    caption: '',
    created_at: '2026-03-18T11:00:00Z',
  },
];

// ── Dev mode sample drafts ──
const DEV_DRAFTS = [
  {
    id: 'dev-draft-1',
    post_type: 'before_after',
    caption: "Cannot get over this lamination & hybrid dye set — the definition is unreal. DM me to book yours ✨",
    hashtags: ['#brows', '#browlamination', '#browgoals', '#beautysalon', '#browsonfleek'],
    image_url: null,
    status: 'draft',
    created_at: new Date().toISOString(),
  },
  {
    id: 'dev-draft-2',
    post_type: 'last_minute_availability',
    caption: "Gap alert 💫 I've had a cancellation on Thursday — who wants it? DM me quick xx",
    hashtags: ['#lastminute', '#availabilitydrop', '#booknow'],
    image_url: null,
    status: 'draft',
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
];

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, var(--bg, #FAF8F5))',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #2D2A26)'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 8
  },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },
  uploadBtn: {
    padding: '10px 18px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
    color: 'var(--bg-card, #fff)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  tabs: {
    display: 'flex',
    gap: 24,
    borderBottom: '1px solid var(--border, var(--border, #EDE9E4))',
    marginBottom: 16
  },
  tab: {
    padding: '10px 0',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.2s'
  },

  // Ideas
  ideaIntro: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', marginBottom: 16, lineHeight: 1.5 },
  ideaGroup: { marginBottom: 16 },
  ideaGroupHeader: { marginBottom: 6 },
  ideaGroupLabel: { fontSize: 11, fontWeight: 600, color: 'var(--accent, #C76B8A)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  ideaCard: {
    background: 'var(--bg-card, #FFFFFF)',
    borderRadius: 12,
    padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    cursor: 'pointer',
    transition: 'transform 0.1s',
    position: 'relative',
  },
  ideaCaption: { fontSize: 14, lineHeight: 1.6, margin: '0 0 8px', color: 'var(--text-primary, #2D2A26)' },
  ideaTap: { fontSize: 11, color: 'var(--accent, #C76B8A)', fontWeight: 600 },

  // Compose
  composeArea: { display: 'flex', flexDirection: 'column', gap: 12 },
  composeTypeRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  composeTypeBtn: {
    padding: '6px 12px',
    borderRadius: 8,
    border: 'none',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  photoArea: {
    borderRadius: 12,
    border: '1.5px dashed var(--border, var(--border, #EDE9E4))',
    overflow: 'hidden',
    cursor: 'pointer',
    minHeight: 120,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 20 },
  previewImg: { width: '100%', maxHeight: 240, objectFit: 'cover', display: 'block' },
  composeTextarea: {
    width: '100%',
    padding: '14px',
    borderRadius: 12,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    fontSize: 14,
    fontFamily: 'inherit',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.6,
    boxSizing: 'border-box',
  },
  shuffleBtn: {
    alignSelf: 'flex-start',
    padding: '6px 14px',
    borderRadius: 8,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    background: 'transparent',
    color: 'var(--text-secondary, #7A756F)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  hashtagInput: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    color: '#4A90D9',
    boxSizing: 'border-box',
  },
  composeActions: { display: 'flex', gap: 8, marginTop: 4 },
  primaryBtn: {
    flex: 1,
    padding: '14px 0',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
    color: 'var(--bg-card, #fff)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cancelBtn: {
    padding: '14px 20px',
    borderRadius: 12,
    border: 'none',
    background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))',
    color: 'var(--text-secondary, #7A756F)',
    fontSize: 15,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Posts
  postList: { display: 'flex', flexDirection: 'column', gap: 14 },
  postCard: {
    background: 'var(--bg-card, #FFFFFF)',
    borderRadius: 14,
    padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  typeBadge: {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 10
  },
  imageContainer: { borderRadius: 10, overflow: 'hidden', marginBottom: 12 },
  postImage: { width: '100%', height: 200, objectFit: 'cover', display: 'block' },
  caption: { fontSize: 14, lineHeight: 1.6, margin: '0 0 10px', whiteSpace: 'pre-wrap' },
  hashtags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  hashtag: { fontSize: 12, color: '#4A90D9', background: '#EEF4FC', padding: '3px 8px', borderRadius: 6 },
  actions: { display: 'flex', gap: 8 },
  publishBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
    color: 'var(--bg-card, #fff)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  editBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent-light, #FFF0F3)',
    color: 'var(--accent, #C76B8A)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  discardBtn: {
    padding: '10px 14px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))',
    color: 'var(--text-muted, #7a7470)',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  editArea: { marginBottom: 12 },
  editTextarea: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--accent, #C76B8A)',
    fontSize: 14,
    fontFamily: 'inherit',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.5,
    boxSizing: 'border-box'
  },
  editActions: { display: 'flex', gap: 8, marginTop: 8 },
  saveEditBtn: {
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  cancelEditBtn: {
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))', color: 'var(--text-secondary, #7A756F)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  statsRow: {
    display: 'flex',
    gap: 16,
    padding: '10px 0',
    borderTop: '1px solid var(--bg-hover, var(--bg-subtle, #F5F2EF))',
    marginTop: 8
  },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statNum: { fontSize: 16, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #7a7470)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  postedDate: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #7a7470)', margin: 0, lineHeight: 1.5 },

  // Gallery
  galleryHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  galleryAddBtn: {
    padding: '8px 14px', borderRadius: 8, border: 'none',
    background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  },
  galleryAddCard: {
    background: 'var(--bg-card, #FFFFFF)', borderRadius: 14, padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 8,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  galleryPhotoPair: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' },
  galleryPhotoSlot: {
    flex: 1, maxWidth: 160, aspectRatio: '1', borderRadius: 12,
    border: '1.5px dashed var(--border, var(--border, #EDE9E4))', overflow: 'hidden', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  galleryPlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  galleryPlaceholderText: { fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  galleryThumb: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  galleryArrow: { fontSize: 18, color: 'var(--text-muted, #7a7470)', flexShrink: 0 },
  gallerySelect: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary, #2D2A26)', background: 'var(--bg-card, #FFFFFF)',
  },
  galleryNotesInput: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  galleryFormActions: { display: 'flex', gap: 8 },
  galleryCard: {
    background: 'var(--bg-card, #FFFFFF)', borderRadius: 14, overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 4,
  },
  galleryPhotoPairView: { display: 'flex', gap: 2 },
  galleryPhotoView: { flex: 1, position: 'relative' },
  galleryViewImg: { width: '100%', height: 160, objectFit: 'cover', display: 'block' },
  galleryLabel: {
    position: 'absolute', bottom: 6, left: 6,
    padding: '2px 8px', borderRadius: 4,
    background: 'rgba(0,0,0,0.5)', color: 'var(--bg-card, #fff)',
    fontSize: 10, fontWeight: 600,
  },
  galleryCardFooter: { padding: '10px 14px' },
  galleryTreatmentName: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  galleryCaption: { display: 'block', fontSize: 12, color: 'var(--text-secondary, #7A756F)', marginTop: 2 },
  galleryDate: { display: 'block', fontSize: 10, color: 'var(--text-muted, #7a7470)', marginTop: 4 },

  // AI suggestions
  aiSuggestionsSection: { marginBottom: 4 },
  aiSuggestionsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  refreshBtn: { padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border, #EDE9E4)', background: 'transparent', cursor: 'pointer', fontSize: 14, color: 'var(--text-muted, #7a7470)', fontFamily: 'inherit' },
  aiLoadingCard: { padding: 14, borderRadius: 12, background: 'linear-gradient(135deg, #FBF0F3, #F3EEFF)', textAlign: 'center' },
  aiSuggestionCard: {
    background: 'linear-gradient(135deg, #FBF0F3, #F3EEFF)',
    borderRadius: 12,
    padding: '12px 14px',
    marginBottom: 8,
    cursor: 'pointer',
    border: '1px solid rgba(199,107,138,0.15)',
  },
  aiSuggestionTreatment: { display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--accent, #C76B8A)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  aiSuggestionCaption: { margin: '0 0 6px', fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary, #2D2A26)' },
};
