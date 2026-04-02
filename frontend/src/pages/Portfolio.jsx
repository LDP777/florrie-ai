/**
 * Portfolio — Photo Gallery & Before/After showcase.
 *
 * Solo beauticians live and die by their portfolio. This page lets Ellie
 * upload treatment photos, tag them, and create before/after pairs that
 * she can share to Instagram or embed on her booking page.
 */
import { useState, useEffect, useCallback } from 'react';
import { isDevMode, useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';

// ── Dev mock data ─────────────────────────────────────────
const DEV_PHOTOS = [
  { id: 'p1', url: null, treatment: 'Lamination & Hybrid Dye', client: 'Shauna', date: '2026-03-18', type: 'after', tags: ['brows', 'lamination'], pair_id: 'pair1' },
  { id: 'p2', url: null, treatment: 'Lamination & Hybrid Dye', client: 'Shauna', date: '2026-03-18', type: 'before', tags: ['brows', 'lamination'], pair_id: 'pair1' },
  { id: 'p3', url: null, treatment: 'Ombre Brows (Semi-Permanent)', client: 'Daisy S', date: '2026-03-12', type: 'after', tags: ['brows', 'semi-permanent'], pair_id: 'pair2' },
  { id: 'p4', url: null, treatment: 'Ombre Brows (Semi-Permanent)', client: 'Daisy S', date: '2026-03-12', type: 'before', tags: ['brows', 'semi-permanent'], pair_id: 'pair2' },
  { id: 'p5', url: null, treatment: 'Lash Lift & Tint', client: 'Jasmin', date: '2026-03-08', type: 'after', tags: ['lashes', 'lift'], pair_id: 'pair3' },
  { id: 'p6', url: null, treatment: 'Lash Lift & Tint', client: 'Jasmin', date: '2026-03-08', type: 'before', tags: ['lashes', 'lift'], pair_id: 'pair3' },
  { id: 'p7', url: null, treatment: 'HD Brows', client: 'Shauna', date: '2026-02-28', type: 'single', tags: ['brows', 'hd'], pair_id: null },
  { id: 'p8', url: null, treatment: 'Combination Brows (Semi-Permanent)', client: 'Daisy S', date: '2026-02-20', type: 'after', tags: ['brows', 'semi-permanent'], pair_id: 'pair4' },
  { id: 'p9', url: null, treatment: 'Combination Brows (Semi-Permanent)', client: 'Daisy S', date: '2026-02-20', type: 'before', tags: ['brows', 'semi-permanent'], pair_id: 'pair4' },
  { id: 'p10', url: null, treatment: 'Lamination Maintenance / Tint', client: 'Jasmin', date: '2026-02-14', type: 'single', tags: ['brows', 'maintenance'], pair_id: null },
];

const FILTER_TAGS = ['All', 'Brows', 'Lashes', 'Semi-permanent'];
const PLACEHOLDER_COLOURS = ['#E8D5C4', '#D4C4B0', '#C4B5A0', '#B8A898', '#CDB4A0', '#D8C8B8', '#E0D0C0', '#C8B8A8', '#D0C0B0', '#DDD0C4'];

export default function Portfolio() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('gallery');
  const [filter, setFilter] = useState('All');
  const [showUpload, setShowUpload] = useState(false);
  const [selectedPair, setSelectedPair] = useState(null);
  const [uploadForm, setUploadForm] = useState({ treatment: '', client: '', type: 'after', tags: [] });
  const [photos, setPhotos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState(null);

  async function handleDeletePhoto(id) {
    if (!confirm('Delete this photo?')) return;
    try {
      await deleteRow('portfolio_photos', id);
      setPhotos(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      logger.error('Failed to delete photo:', err);
    }
  }

  function handleEditPhoto(photo, e) {
    if (e) e.stopPropagation();
    setEditingPhoto(photo);
    setUploadForm({
      treatment: photo.treatment || '',
      client: photo.client || '',
      type: photo.type || 'after',
      tags: photo.tags || [],
    });
    setShowUpload(true);
  }

  async function handleSharePhoto(pair, channel) {
    const photo = pair?.after || pair?.before || pair;
    const treatmentName = photo?.treatment || 'Treatment';
    const clientName = photo?.client || '';

    if (channel === 'Copy Link') {
      const shareUrl = `${window.location.origin}/portfolio/${photo?.id || ''}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        alert('Link copied!');
      } catch { alert('Could not copy link'); }
    } else if (channel === 'WhatsApp') {
      const text = encodeURIComponent(`Check out this ${treatmentName} result${clientName ? ` for ${clientName}` : ''}!`);
      window.open(`https://wa.me/?text=${text}`, '_blank');
    } else if (channel === 'Instagram') {
      alert('Save the photo to your camera roll to share on Instagram.');
    }
  }

  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) { setPhotos(DEV_PHOTOS); return; }
    fetchRows('portfolio_photos', beautician.id, { order: 'date', ascending: false })
      .then(rows => setPhotos(rows))
      .catch(err => logger.error('Failed to load portfolio:', err));
  }, [beautician, bLoading]);

  // Group into pairs and singles
  const pairs = {};
  const singles = [];
  photos.forEach(p => {
    if (p.pair_id) {
      if (!pairs[p.pair_id]) pairs[p.pair_id] = {};
      pairs[p.pair_id][p.type] = p;
    } else {
      singles.push(p);
    }
  });

  const pairList = Object.values(pairs);

  // Filter
  const filterPhotos = (list) => {
    if (filter === 'All') return list;
    const tag = filter.toLowerCase();
    return list.filter(p => p.tags?.includes(tag));
  };

  const filterPairs = (pList) => {
    if (filter === 'All') return pList;
    const tag = filter.toLowerCase();
    return pList.filter(pair => {
      const p = pair.after || pair.before;
      return p?.tags?.includes(tag);
    });
  };

  const filteredPairs = filterPairs(pairList);
  const filteredSingles = filterPhotos(singles);

  const stats = {
    total: photos.length,
    pairs: pairList.length,
    treatments: [...new Set(photos.map(p => p.treatment))].length,
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Portfolio</h1>
        <button style={S.uploadBtn} onClick={() => setShowUpload(true)}>+ Add Photo</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Photos', value: stats.total, colour: 'var(--accent, #C76B8A)' },
          { label: 'Before/After', value: stats.pairs, colour: 'var(--text-secondary, #8B6F5E)' },
          { label: 'Treatments', value: stats.treatments, colour: '#6B8F7B' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['gallery', 'before-after'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'gallery' ? 'Gallery' : 'Before / After'}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={S.filters}>
        {FILTER_TAGS.map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ ...S.filterChip, ...(filter === f ? S.filterActive : {}) }}>
            {f}
          </button>
        ))}
      </div>

      {/* Gallery tab */}
      {tab === 'gallery' && (
        <div style={S.grid}>
          {filterPhotos(photos).map((p, i) => (
            <div key={p.id} style={S.gridItem}>
              <div style={{ ...S.photoPlaceholder, background: PLACEHOLDER_COLOURS[i % PLACEHOLDER_COLOURS.length] }}>
                <span style={S.placeholderIcon}>📷</span>
              </div>
              <div style={S.photoMeta}>
                <span style={S.photoTreatment}>{p.treatment}</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={S.photoClient}>{p.client}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={(e) => handleEditPhoto(p, e)} style={{ ...S.deleteBtn, color: 'var(--accent, #C76B8A)' }}>✎</button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeletePhoto(p.id); }} style={S.deleteBtn}>×</button>
                  </div>
                </div>
              </div>
              {p.type !== 'single' && (
                <span style={{ ...S.typeBadge, background: p.type === 'before' ? 'var(--border, var(--border, var(--border, #EDE9E4)))' : '#F0E6ED', color: p.type === 'before' ? 'var(--text-secondary, #8B6F5E)' : 'var(--accent, #C76B8A)' }}>
                  {p.type}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Before/After tab */}
      {tab === 'before-after' && (
        <div style={S.pairsContainer}>
          {filteredPairs.length === 0 && <p style={S.empty}>No before/after pairs for this filter.</p>}
          {filteredPairs.map((pair, i) => {
            const after = pair.after || {};
            return (
              <div key={i} style={S.pairCard} onClick={() => setSelectedPair(selectedPair === i ? null : i)}>
                <div style={S.pairHeader}>
                  <span style={S.pairTreatment}>{after.treatment}</span>
                  <span style={S.pairDate}>{after.date}</span>
                </div>
                <div style={S.pairPhotos}>
                  <div style={S.pairSide}>
                    <div style={{ ...S.pairPhoto, background: PLACEHOLDER_COLOURS[i * 2] }}>
                      <span style={S.placeholderIcon}>📷</span>
                    </div>
                    <span style={S.pairLabel}>Before</span>
                  </div>
                  <div style={S.arrowContainer}>
                    <span style={S.arrow}>→</span>
                  </div>
                  <div style={S.pairSide}>
                    <div style={{ ...S.pairPhoto, background: PLACEHOLDER_COLOURS[i * 2 + 1] }}>
                      <span style={S.placeholderIcon}>📷</span>
                    </div>
                    <span style={S.pairLabel}>After</span>
                  </div>
                </div>
                <div style={S.pairClient}>{after.client}</div>

                {/* Expanded: share buttons */}
                {selectedPair === i && (
                  <div style={S.shareRow}>
                    {['Instagram', 'WhatsApp', 'Copy Link'].map(ch => (
                      <button key={ch} style={S.shareBtn} onClick={(e) => { e.stopPropagation(); handleSharePhoto(pair, ch); }}>{ch}</button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Upload modal */}
      {showUpload && (
        <div style={S.overlay} onClick={() => { setShowUpload(false); setEditingPhoto(null); setUploadForm({ treatment: '', client: '', type: 'after', tags: [] }); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>{editingPhoto ? 'Edit Photo' : 'Add Photo'}</h2>

            {/* Upload zone */}
            <div style={S.uploadZone}>
              <span style={{ fontSize: 32 }}>📸</span>
              <span style={S.uploadText}>Tap to select photo</span>
              <span style={S.uploadHint}>From camera roll or gallery</span>
            </div>

            {/* Photo type */}
            <div style={S.fieldLabel}>Photo Type</div>
            <div style={S.typeRow}>
              {['before', 'after', 'single'].map(t => (
                <button key={t} onClick={() => setUploadForm(f => ({ ...f, type: t }))} style={{ ...S.typeBtn, ...(uploadForm.type === t ? S.typeBtnActive : {}) }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Treatment */}
            <div style={S.fieldLabel}>Treatment</div>
            <select style={S.select} value={uploadForm.treatment} onChange={e => setUploadForm(f => ({ ...f, treatment: e.target.value }))}>
              <option value="">Select treatment</option>
              <option value="Lamination & Hybrid Dye">Lamination & Hybrid Dye</option>
              <option value="HD Brows">HD Brows</option>
              <option value="Lash Lift & Tint">Lash Lift & Tint</option>
              <option value="Ombre Brows (Semi-Permanent)">Ombre Brows</option>
            </select>

            {/* Client */}
            <div style={S.fieldLabel}>Client (optional)</div>
            <input style={S.input} placeholder="Client name" value={uploadForm.client} onChange={e => setUploadForm(f => ({ ...f, client: e.target.value }))} />

            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={async () => {
              if (!uploadForm.treatment) return;
              setSaving(true);
              try {
                if (editingPhoto) {
                  // Update existing photo
                  const updated = await updateRow('portfolio_photos', editingPhoto.id, {
                    treatment: uploadForm.treatment,
                    client: uploadForm.client || null,
                    type: uploadForm.type,
                    tags: uploadForm.tags,
                  });
                  setPhotos(prev => prev.map(p => p.id === editingPhoto.id ? { ...p, ...updated } : p));
                } else {
                  // Create new photo
                  const created = await insertRow('portfolio_photos', {
                    beautician_id: beautician.id,
                    treatment: uploadForm.treatment,
                    client: uploadForm.client || null,
                    type: uploadForm.type,
                    tags: uploadForm.tags,
                    date: new Date().toISOString().split('T')[0],
                  });
                  setPhotos(prev => [created, ...prev]);
                }
                setShowUpload(false);
                setEditingPhoto(null);
                setUploadForm({ treatment: '', client: '', type: 'after', tags: [] });
              } catch (err) {
                logger.error('Failed to save photo:', err);
              } finally {
                setSaving(false);
              }
            }}>
              {saving ? 'Saving…' : editingPhoto ? 'Save Changes' : 'Save Photo'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: 0 },
  uploadBtn: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 20, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },

  tabs: { display: 'flex', gap: 8, marginBottom: 12 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' },

  filters: { display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' },
  filterChip: { padding: '6px 14px', borderRadius: 16, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--card, #fff)', color: 'var(--text-secondary, #8B6F5E)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterActive: { background: 'var(--text-primary, #2D2A26)', color: 'var(--bg-card, #fff)', border: '1px solid var(--text-primary, #2D2A26)' },

  // Gallery grid
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 },
  gridItem: { position: 'relative', borderRadius: 12, overflow: 'hidden', background: 'var(--card, #fff)' },
  photoPlaceholder: { aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px 12px 0 0' },
  placeholderIcon: { fontSize: 28, opacity: 0.5 },
  photoMeta: { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 },
  photoTreatment: { fontSize: 12, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  photoClient: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  typeBadge: { position: 'absolute', top: 8, right: 8, padding: '3px 8px', borderRadius: 8, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' },

  // Before/After pairs
  pairsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  pairCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  pairHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 10 },
  pairTreatment: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  pairDate: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  pairPhotos: { display: 'flex', alignItems: 'center', gap: 8 },
  pairSide: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  pairPhoto: { width: '100%', aspectRatio: '1', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  pairLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textTransform: 'uppercase', letterSpacing: '0.05em' },
  arrowContainer: { padding: '0 4px' },
  arrow: { fontSize: 20, color: 'var(--accent, #C76B8A)' },
  pairClient: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', marginTop: 8 },
  shareRow: { display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  shareBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },

  empty: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 14, padding: 32 },

  // Upload modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #fff)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: '0 0 16px' },
  uploadZone: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 32, border: '2px dashed var(--border, var(--border, #EDE9E4))', borderRadius: 12, marginBottom: 16, cursor: 'pointer' },
  uploadText: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  uploadHint: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 6, marginTop: 12 },
  typeRow: { display: 'flex', gap: 8 },
  typeBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },
  typeBtnActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', border: '1px solid var(--accent, #C76B8A)' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)', background: 'var(--bg-card, #fff)', outline: 'none' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)', outline: 'none', boxSizing: 'border-box' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
  deleteBtn: { background: 'none', border: 'none', fontSize: 16, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
};
