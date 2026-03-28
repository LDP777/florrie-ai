/**
 * Client Tags & Segments — Group, filter & target clients.
 *
 * Every beautician mentally labels clients ("VIP", "patch-test needed",
 * "always late"). This page makes it explicit so florrie.ai can use the
 * tags across campaigns, waitlist priority, and smart scheduling.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode, DEV_CLIENTS } from '../lib/supabase.js';

const DEV_TAGS = [
  { id: 't1', name: 'VIP', colour: '#C76B8A', icon: '⭐', auto: false, clients: ['Shauna', 'Daisy S', 'Holly B'] },
  { id: 't2', name: 'Patch Test Due', colour: '#FF9800', icon: '⚠️', auto: true, rule: 'Last patch test > 6 months ago', clients: ['Amy R', 'Beth K'] },
  { id: 't3', name: 'Semi-Perm Client', colour: '#9C27B0', icon: '💎', auto: true, rule: 'Has booked any semi-permanent treatment', clients: ['Shauna', 'Daisy S', 'Holly B', 'Amy R', 'Beth K'] },
  { id: 't4', name: 'New Client', colour: '#4CAF50', icon: '🌱', auto: true, rule: 'First appointment within last 30 days', clients: ['Megan S'] },
  { id: 't5', name: 'Dormant', colour: '#9E9E9E', icon: '💤', auto: true, rule: 'No visit in 60+ days', clients: ['Natalie W', 'Lucy P'] },
  { id: 't6', name: 'Always Late', colour: '#F44336', icon: '🕐', auto: false, clients: ['Jasmin'] },
  { id: 't7', name: 'Loyalty Gold', colour: '#FFC107', icon: '🏅', auto: true, rule: '10+ appointments completed', clients: ['Shauna'] },
  { id: 't8', name: 'Referred a Friend', colour: '#03A9F4', icon: '🤝', auto: true, rule: 'Has at least 1 referral', clients: ['Daisy S', 'Shauna'] },
];

const DEV_SEGMENTS = [
  { id: 's1', name: 'High-Value Regulars', tags: ['VIP', 'Semi-Perm Client'], match: 'all', count: 3, description: 'VIP clients who book semi-permanent treatments' },
  { id: 's2', name: 'Win-Back Targets', tags: ['Dormant'], match: 'any', count: 2, description: 'Clients who haven\'t visited in 60+ days' },
  { id: 's3', name: 'Patch Test Reminders', tags: ['Patch Test Due', 'Semi-Perm Client'], match: 'all', count: 2, description: 'Semi-perm clients needing a new patch test' },
  { id: 's4', name: 'Brand Ambassadors', tags: ['VIP', 'Referred a Friend'], match: 'any', count: 4, description: 'VIPs and clients who refer others' },
];

export default function ClientTags({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('tags');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState('tag'); // tag | segment
  const [tags, setTags] = useState(DEV_TAGS);
  const [segments, setSegments] = useState(DEV_SEGMENTS);

  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setTags(DEV_TAGS);
      setSegments(DEV_SEGMENTS);
      return;
    }

    // Fetch client_tags (tags) and their assignments
    fetchRows('client_tags', beautician.id)
      .then(rows => {
        setTags(rows.map(t => ({
          id: t.id,
          name: t.name,
          colour: t.colour || '#C76B8A',
          icon: t.icon || '🏷️',
          auto: t.auto_rule ? true : false,
          rule: t.auto_rule || '',
          clients: [], // Assignments fetched separately
        })));
      });

    // Note: Segments are computed from tags in real DB or fetched from a segments table
    // For now, keep DEV_SEGMENTS as fallback
  }, [beautician, bLoading]);

  return (
    <div style={S.page}>
      <h1 style={S.title}>Tags & Segments</h1>

      {/* Overview */}
      <div style={S.overviewRow}>
        <div style={S.overviewCard}>
          <span style={S.overviewNum}>{tags.length}</span>
          <span style={S.overviewLabel}>Tags</span>
        </div>
        <div style={S.overviewCard}>
          <span style={S.overviewNum}>{tags.filter(t => t.auto).length}</span>
          <span style={S.overviewLabel}>Auto-tags</span>
        </div>
        <div style={S.overviewCard}>
          <span style={S.overviewNum}>{segments.length}</span>
          <span style={S.overviewLabel}>Segments</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['tags', 'segments'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'tags' ? `Tags (${tags.length})` : `Segments (${segments.length})`}
          </button>
        ))}
      </div>

      {/* Tags Tab */}
      {tab === 'tags' && (
        <div style={S.list}>
          {tags.map(tag => {
            const isExp = expanded === tag.id;
            return (
              <div key={tag.id} style={S.card} onClick={() => setExpanded(isExp ? null : tag.id)}>
                <div style={S.cardHeader}>
                  <div style={S.cardLeft}>
                    <span style={{ ...S.tagDot, background: tag.colour }}>{tag.icon}</span>
                    <div style={S.cardInfo}>
                      <span style={S.cardName}>{tag.name}</span>
                      <span style={S.cardMeta}>{tag.clients.length} client{tag.clients.length !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <div style={S.cardRight}>
                    {tag.auto && <span style={S.autoBadge}>⚡ Auto</span>}
                    <span style={S.chevron}>{isExp ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExp && (
                  <div style={S.expandedSection}>
                    {tag.auto && tag.rule && (
                      <div style={S.ruleBox}>
                        <span style={S.ruleLabel}>Auto-tag rule</span>
                        <span style={S.ruleValue}>{tag.rule}</span>
                      </div>
                    )}
                    <div style={S.clientChips}>
                      {tag.clients.map(c => (
                        <span key={c} style={S.clientChip}>{c}</span>
                      ))}
                    </div>
                    <div style={S.actionRow}>
                      <button style={S.actionBtn}>Use in Campaign</button>
                      <button style={S.actionBtn}>Edit Tag</button>
                      {!tag.auto && <button style={{ ...S.actionBtn, color: '#F44336' }}>Delete</button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Segments Tab */}
      {tab === 'segments' && (
        <div style={S.list}>
          {segments.map(seg => {
            const isExp = expanded === seg.id;
            return (
              <div key={seg.id} style={S.card} onClick={() => setExpanded(isExp ? null : seg.id)}>
                <div style={S.cardHeader}>
                  <div style={S.cardLeft}>
                    <span style={S.segIcon}>📊</span>
                    <div style={S.cardInfo}>
                      <span style={S.cardName}>{seg.name}</span>
                      <span style={S.cardMeta}>{seg.count} client{seg.count !== 1 ? 's' : ''} · Match {seg.match}</span>
                    </div>
                  </div>
                  <span style={S.chevron}>{isExp ? '▲' : '▼'}</span>
                </div>

                {isExp && (
                  <div style={S.expandedSection}>
                    <p style={S.segDesc}>{seg.description}</p>
                    <div style={S.segTags}>
                      {seg.tags.map(tn => {
                        const t = tags.find(x => x.name === tn);
                        return (
                          <span key={tn} style={{ ...S.segTagChip, background: t ? t.colour + '20' : '#eee', color: t ? t.colour : '#666' }}>
                            {t?.icon} {tn}
                          </span>
                        );
                      })}
                      <span style={S.matchLabel}>{seg.match === 'all' ? 'All tags match' : 'Any tag matches'}</span>
                    </div>
                    <div style={S.actionRow}>
                      <button style={{ ...S.actionBtn, background: '#C76B8A', color: '#fff' }}>Send Campaign</button>
                      <button style={S.actionBtn}>Edit Segment</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create FAB */}
      {!showCreate && (
        <button style={S.fab} onClick={() => setShowCreate(true)}>+</button>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => setShowCreate(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Create {createType === 'tag' ? 'Tag' : 'Segment'}</h2>
              <button style={S.closeBtn} onClick={() => setShowCreate(false)}>✕</button>
            </div>

            {/* Type toggle */}
            <div style={S.typeToggle}>
              {['tag', 'segment'].map(t => (
                <button key={t} onClick={() => setCreateType(t)} style={{ ...S.typeBtn, ...(createType === t ? S.typeBtnActive : {}) }}>
                  {t === 'tag' ? '🏷️ Tag' : '📊 Segment'}
                </button>
              ))}
            </div>

            {createType === 'tag' ? (
              <div style={S.formBody}>
                <label style={S.label}>Tag Name</label>
                <input style={S.input} placeholder="e.g. Sensitive Skin" />

                <label style={S.label}>Colour</label>
                <div style={S.colourRow}>
                  {['#C76B8A', '#FF9800', '#4CAF50', '#9C27B0', '#03A9F4', '#F44336', '#FFC107', '#9E9E9E'].map(c => (
                    <div key={c} style={{ ...S.colourDot, background: c }} />
                  ))}
                </div>

                <label style={S.label}>Type</label>
                <div style={S.typeToggle}>
                  <button style={{ ...S.typeBtn, ...S.typeBtnActive }}>Manual</button>
                  <button style={S.typeBtn}>Auto-rule</button>
                </div>

                <label style={S.label}>Assign to Clients</label>
                <div style={S.clientChips}>
                  {(DEV_CLIENTS || []).slice(0, 6).map(c => (
                    <span key={c.name} style={S.clientChipSelect}>{c.name}</span>
                  ))}
                </div>
              </div>
            ) : (
              <div style={S.formBody}>
                <label style={S.label}>Segment Name</label>
                <input style={S.input} placeholder="e.g. Lapsed VIPs" />

                <label style={S.label}>Description</label>
                <input style={S.input} placeholder="Who this targets and why" />

                <label style={S.label}>Include Tags</label>
                <div style={S.clientChips}>
                  {tags.map(t => (
                    <span key={t.id} style={{ ...S.segTagChip, background: t.colour + '20', color: t.colour, cursor: 'pointer' }}>
                      {t.icon} {t.name}
                    </span>
                  ))}
                </div>

                <label style={S.label}>Match Rule</label>
                <div style={S.typeToggle}>
                  <button style={{ ...S.typeBtn, ...S.typeBtnActive }}>All tags</button>
                  <button style={S.typeBtn}>Any tag</button>
                </div>
              </div>
            )}

            <button style={S.saveBtn}>Create {createType === 'tag' ? 'Tag' : 'Segment'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },

  overviewRow: { display: 'flex', gap: 8, marginBottom: 16 },
  overviewCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  overviewNum: { fontSize: 22, fontWeight: 700, color: '#C76B8A' },
  overviewLabel: { fontSize: 11, color: '#AAA5A0', fontWeight: 500 },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  tagDot: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  segIcon: { fontSize: 20 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  cardMeta: { fontSize: 12, color: '#AAA5A0' },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8 },
  autoBadge: { padding: '3px 8px', borderRadius: 6, background: '#FFF8E1', color: '#F9A825', fontSize: 10, fontWeight: 600 },
  chevron: { fontSize: 10, color: '#AAA5A0' },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  ruleBox: { background: '#F9F7F4', borderRadius: 8, padding: 10, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 },
  ruleLabel: { fontSize: 10, fontWeight: 600, color: '#AAA5A0', textTransform: 'uppercase' },
  ruleValue: { fontSize: 13, color: 'var(--text, #2D2A26)', fontWeight: 500 },
  clientChips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  clientChip: { padding: '5px 12px', borderRadius: 20, background: '#F0E6ED', color: '#C76B8A', fontSize: 12, fontWeight: 500 },
  clientChipSelect: { padding: '5px 12px', borderRadius: 20, background: '#F0ECE8', color: '#8B6F5E', fontSize: 12, fontWeight: 500, cursor: 'pointer' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  segDesc: { fontSize: 13, color: '#8B6F5E', margin: '0 0 10px', lineHeight: 1.4 },
  segTags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' },
  segTagChip: { padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600 },
  matchLabel: { fontSize: 11, color: '#AAA5A0', fontStyle: 'italic' },

  fab: { position: 'fixed', bottom: 80, right: 20, width: 52, height: 52, borderRadius: 26, background: '#C76B8A', color: '#fff', fontSize: 26, border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(199,107,138,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', zIndex: 50 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg, #FAF8F5)', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: '#AAA5A0', cursor: 'pointer' },

  typeToggle: { display: 'flex', gap: 8, marginBottom: 14 },
  typeBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: '#AAA5A0' },
  typeBtnActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },

  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontSize: 12, fontWeight: 600, color: '#AAA5A0', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--card, #fff)' },
  colourRow: { display: 'flex', gap: 10 },
  colourDot: { width: 28, height: 28, borderRadius: 14, cursor: 'pointer', border: '2px solid transparent' },

  saveBtn: { marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
