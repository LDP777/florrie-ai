/**
 * Client Tags & Segments - Group, filter & target clients.
 *
 * Every beautician mentally labels clients ("VIP", "patch-test needed",
 * "always late"). This page makes it explicit so florrie.ai can use the
 * tags across campaigns, waitlist priority, and smart scheduling.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon, { iconName } from '../components/ui/Icon';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader.jsx';
const DEV_TAGS = [
  { id: 't1', name: 'VIP', colour: 'var(--accent, #92405e)', icon: 'star', auto: false, clients: ['Shauna', 'Daisy S', 'Holly B'] },
  { id: 't2', name: 'Patch Test Due', colour: '#FF9800', icon: 'alert-triangle', auto: true, rule: 'Last patch test > 6 months ago', clients: ['Amy R', 'Beth K'] },
  { id: 't3', name: 'Semi-Perm Client', colour: '#9C27B0', icon: 'sparkles', auto: true, rule: 'Has booked any semi-permanent treatment', clients: ['Shauna', 'Daisy S', 'Holly B', 'Amy R', 'Beth K'] },
  { id: 't4', name: 'New Client', colour: '#306F33', icon: 'flower', auto: true, rule: 'First appointment within last 30 days', clients: ['Megan S'] },
  { id: 't5', name: 'Dormant', colour: '#9E9E9E', icon: 'moon', auto: true, rule: 'No visit in 60+ days', clients: ['Natalie W', 'Lucy P'] },
  { id: 't6', name: 'Always Late', colour: '#F44336', icon: 'clock', auto: false, clients: ['Jasmin'] },
  { id: 't7', name: 'Loyalty Gold', colour: '#FFC107', icon: 'badge', auto: true, rule: '10+ appointments completed', clients: ['Shauna'] },
  { id: 't8', name: 'Referred a Friend', colour: '#03A9F4', icon: 'users', auto: true, rule: 'Has at least 1 referral', clients: ['Daisy S', 'Shauna'] },
];

const DEV_SEGMENTS = [
  { id: 's1', name: 'High-Value Regulars', tags: ['VIP', 'Semi-Perm Client'], match: 'all', count: 3, description: 'VIP clients who book semi-permanent treatments' },
  { id: 's2', name: 'Win-Back Targets', tags: ['Dormant'], match: 'any', count: 2, description: 'Clients who haven\'t visited in 60+ days' },
  { id: 's3', name: 'Patch Test Reminders', tags: ['Patch Test Due', 'Semi-Perm Client'], match: 'all', count: 2, description: 'Semi-perm clients needing a new patch test' },
  { id: 's4', name: 'Brand Ambassadors', tags: ['VIP', 'Referred a Friend'], match: 'any', count: 4, description: 'VIPs and clients who refer others' },
];

export default function ClientTags() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('tags');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState('tag'); // tag | segment
  const [tags, setTags] = useState([]);
  const [segments, setSegments] = useState([]);
  const [tagForm, setTagForm] = useState({ name: '', colour: 'var(--accent, #92405e)', icon: 'tag' });
  const [segForm, setSegForm] = useState({ name: '', description: '', selectedTags: [], match: 'all' });
  const [saving, setSaving] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [editingSegment, setEditingSegment] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (bLoading || !beautician) return;

    // Fetch client_tags (tags) and their assignments
    fetchRows('client_tags', beautician.id)
      .then(rows => {
        setTags(rows.map(t => ({
          id: t.id,
          name: t.name,
          colour: t.colour || 'var(--accent, #92405e)',
          icon: t.icon || '🏷️',
          auto: t.auto_rule ? true : false,
          rule: t.auto_rule || '',
          clients: [], // Assignments fetched separately
        })));
      })
      .catch(err => {
        logger.error('Failed to fetch tags:', err);
        setError('Failed to load tags');
      });

    // Fetch segments table
    fetchRows('segments', beautician.id)
      .then(rows => {
        setSegments(rows.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          tags: s.tags || [],
          match: s.match || 'all',
          count: s.count || 0,
        })));
      })
      .catch(err => {
        logger.error('Failed to fetch segments:', err);
        setSegments([]);
      });
  }, [beautician, bLoading]);

  return (
    <div style={S.page}>
      <PageHeader title="Tags & Segments" />

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
          <Button key={t} variant="chip" size="sm" aria-pressed={tab === t} onClick={() => setTab(t)} style={{ flex: 1 }}>
            {t === 'tags' ? `Tags (${tags.length})` : `Segments (${segments.length})`}
          </Button>
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
                    <span style={{ ...S.tagDot, background: tag.colour }}><Icon name={iconName(tag.icon)} inline /></span>
                    <div style={S.cardInfo}>
                      <span style={S.cardName}>{tag.name}</span>
                      <span style={S.cardMeta}>{tag.clients.length} client{tag.clients.length !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <div style={S.cardRight}>
                    {tag.auto && <span style={S.autoBadge}><Icon name="sparkles" size={14} inline /> Auto</span>}
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
                      <Button variant="secondary" size="sm" style={{ flex: 1 }}>Use in Campaign</Button>
                      <Button variant="secondary" size="sm" style={{ flex: 1 }} onClick={(e) => {
                        e.stopPropagation();
                        setEditingTag(tag);
                        setTagForm({ name: tag.name, colour: tag.colour, icon: tag.icon });
                        setShowCreate(true);
                        setCreateType('tag');
                      }}>Edit Tag</Button>
                      {!tag.auto && <Button variant="secondary" size="sm" style={{ flex: 1, color: '#F44336' }} onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`Delete "${tag.name}" tag?`)) return;
                        try {
                          await deleteRow('client_tags', tag.id);
                          setTags(prev => prev.filter(t => t.id !== tag.id));
                        } catch (err) {
                          logger.error('Failed to delete tag:', err);
                          setError('Failed to delete tag');
                        }
                      }}>Delete</Button>}
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
                    <span style={S.segIcon}><Icon name="chart" size={15} /></span>
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
                      <Button variant="primary" size="sm" style={{ flex: 1 }}>Send Campaign</Button>
                      <Button variant="secondary" size="sm" style={{ flex: 1 }} onClick={(e) => {
                        e.stopPropagation();
                        setEditingSegment(seg);
                        setSegForm({ name: seg.name, description: seg.description, selectedTags: seg.tags, match: seg.match });
                        setShowCreate(true);
                        setCreateType('segment');
                      }}>Edit Segment</Button>
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
        <Button variant="primary" icon style={S.fab} onClick={() => setShowCreate(true)}>+</Button>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => {
          setShowCreate(false);
          setEditingTag(null);
          setEditingSegment(null);
          setTagForm({ name: '', colour: 'var(--accent, #92405e)', icon: 'tag' });
          setSegForm({ name: '', description: '', selectedTags: [], match: 'all' });
          setError('');
        }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>{editingTag || editingSegment ? 'Edit' : 'Create'} {createType === 'tag' ? 'Tag' : 'Segment'}</h2>
              <Button variant="quiet" icon aria-label="Close" style={{ color: 'var(--text-muted, #6B5D54)' }} onClick={() => {
                setShowCreate(false);
                setEditingTag(null);
                setEditingSegment(null);
                setTagForm({ name: '', colour: 'var(--accent, #92405e)', icon: 'tag' });
                setSegForm({ name: '', description: '', selectedTags: [], match: 'all' });
                setError('');
              }}><Icon name="x" size={15} /></Button>
            </div>

            {/* Type toggle */}
            <div style={S.typeToggle}>
              {['tag', 'segment'].map(t => (
                <Button key={t} variant={createType === t ? 'primary' : 'secondary'} size="sm" onClick={() => setCreateType(t)} style={{ flex: 1 }}>
                  {t === 'tag' ? '🏷️ Tag' : 'Segment'}
                </Button>
              ))}
            </div>

            {createType === 'tag' ? (
              <div style={S.formBody}>
                <label style={S.label}>Tag Name</label>
                <input style={S.input} placeholder="e.g. Sensitive Skin" value={tagForm.name} onChange={e => setTagForm(f => ({ ...f, name: e.target.value }))} />

                <label style={S.label}>Colour</label>
                <div style={S.colourRow}>
                  {['var(--accent, #92405e)', '#FF9800', '#306F33', '#9C27B0', '#03A9F4', '#F44336', '#FFC107', '#9E9E9E'].map(c => (
                    <div key={c} style={{ ...S.colourDot, background: c, border: tagForm.colour === c ? '3px solid var(--text-primary)' : '2px solid transparent', cursor: 'pointer' }} onClick={() => setTagForm(f => ({ ...f, colour: c }))} />
                  ))}
                </div>

                <label style={S.label}>Type</label>
                <div style={S.typeToggle}>
                  <Button variant="primary" size="sm" style={{ flex: 1 }}>Manual</Button>
                  <Button variant="secondary" size="sm" style={{ flex: 1 }}>Auto-rule</Button>
                </div>
              </div>
            ) : (
              <div style={S.formBody}>
                <label style={S.label}>Segment Name</label>
                <input style={S.input} placeholder="e.g. Lapsed VIPs" value={segForm.name} onChange={e => setSegForm(f => ({ ...f, name: e.target.value }))} />

                <label style={S.label}>Description</label>
                <input style={S.input} placeholder="Who this targets and why" value={segForm.description} onChange={e => setSegForm(f => ({ ...f, description: e.target.value }))} />

                <label style={S.label}>Include Tags</label>
                <div style={S.clientChips}>
                  {tags.map(t => (
                    <span key={t.id} onClick={() => setSegForm(f => ({
                      ...f,
                      selectedTags: f.selectedTags.includes(t.name) ? f.selectedTags.filter(x => x !== t.name) : [...f.selectedTags, t.name],
                    }))} style={{ ...S.segTagChip, background: segForm.selectedTags.includes(t.name) ? t.colour : t.colour + '20', color: segForm.selectedTags.includes(t.name) ? 'var(--bg-card, #FFFCF9)' : t.colour, cursor: 'pointer' }}>
                      <Icon name={iconName(t.icon)} inline /> {t.name}
                    </span>
                  ))}
                </div>

                <label style={S.label}>Match Rule</label>
                <div style={S.typeToggle}>
                  <Button variant={segForm.match === 'all' ? 'primary' : 'secondary'} size="sm" onClick={() => setSegForm(f => ({ ...f, match: 'all' }))} style={{ flex: 1 }}>All tags</Button>
                  <Button variant={segForm.match === 'any' ? 'primary' : 'secondary'} size="sm" onClick={() => setSegForm(f => ({ ...f, match: 'any' }))} style={{ flex: 1 }}>Any tag</Button>
                </div>
              </div>
            )}

            <Button variant="primary" size="lg" fullWidth style={{ marginTop: 16, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={async () => {
              setSaving(true);
              setError('');
              try {
                if (createType === 'tag') {
                  if (!tagForm.name.trim()) {
                    setError('Tag name is required');
                    setSaving(false);
                    return;
                  }

                  if (editingTag) {
                    // Update existing tag
                    const updated = await updateRow('client_tags', editingTag.id, {
                      name: tagForm.name.trim(),
                      colour: tagForm.colour,
                      icon: tagForm.icon,
                    });
                    setTags(prev => prev.map(t => t.id === editingTag.id ? { ...updated, auto: t.auto, rule: t.rule, clients: t.clients } : t));
                    setEditingTag(null);
                  } else {
                    // Create new tag
                    const created = await insertRow('client_tags', {
                      beautician_id: beautician.id,
                      name: tagForm.name.trim(),
                      colour: tagForm.colour,
                      icon: tagForm.icon,
                    });
                    setTags(prev => [...prev, { ...created, auto: false, rule: '', clients: [] }]);
                  }

                  setTagForm({ name: '', colour: 'var(--accent, #92405e)', icon: 'tag' });
                } else {
                  if (!segForm.name.trim()) {
                    setError('Segment name is required');
                    setSaving(false);
                    return;
                  }

                  if (editingSegment) {
                    // Update existing segment
                    const updated = await updateRow('segments', editingSegment.id, {
                      name: segForm.name.trim(),
                      description: segForm.description,
                      tags: segForm.selectedTags,
                      match: segForm.match,
                    });
                    setSegments(prev => prev.map(s => s.id === editingSegment.id ? { ...updated, count: s.count } : s));
                    setEditingSegment(null);
                  } else {
                    // Create new segment
                    const created = await insertRow('segments', {
                      beautician_id: beautician.id,
                      name: segForm.name.trim(),
                      description: segForm.description,
                      tags: segForm.selectedTags,
                      match: segForm.match,
                      count: 0,
                    });
                    setSegments(prev => [...prev, { ...created, count: 0 }]);
                  }

                  setSegForm({ name: '', description: '', selectedTags: [], match: 'all' });
                }

                setShowCreate(false);
              } catch (err) {
                logger.error('Failed to save:', err);
                setError(`Failed to ${editingTag || editingSegment ? 'update' : 'create'}`);
              } finally {
                setSaving(false);
              }
            }}>
              {saving ? `${editingTag || editingSegment ? 'Saving' : 'Creating'}…` : `${editingTag || editingSegment ? 'Update' : 'Create'} ${createType === 'tag' ? 'Tag' : 'Segment'}`}
            </Button>

            {error && <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: '#F44336', color: 'var(--bg-card, #FFFCF9)', fontSize: 12, textAlign: 'center' }}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },

  overviewRow: { display: 'flex', gap: 8, marginBottom: 16 },
  overviewCard: { flex: 1, background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  overviewNum: { fontSize: 22, fontWeight: 700, color: 'var(--accent, #92405e)' },
  overviewLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  tagDot: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  segIcon: { fontSize: 20 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  cardMeta: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8 },
  autoBadge: { padding: '3px 8px', borderRadius: 'var(--radius-xs)', background: '#FFF8E1', color: 'var(--warning, #79581C)', fontSize: 10, fontWeight: 600 },
  chevron: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #E8DDD4)' },
  ruleBox: { background: 'var(--bg-hover, var(--bg-subtle, #ede7e3))', borderRadius: 10, padding: 10, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 },
  ruleLabel: { fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase' },
  ruleValue: { fontSize: 13, color: 'var(--text, #241B17)', fontWeight: 500 },
  clientChips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  clientChip: { padding: '5px 12px', borderRadius: 22, background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 500 },
  clientChipSelect: { padding: '5px 12px', borderRadius: 22, background: 'var(--border, #E8DDD4)', color: 'var(--text-secondary, #574A42)', fontSize: 12, fontWeight: 500, cursor: 'pointer' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },

  segDesc: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '0 0 10px', lineHeight: 1.4 },
  segTags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' },
  segTagChip: { padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600 },
  matchLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontStyle: 'italic' },

  fab: { position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)', left: 20, width: 52, height: 52, borderRadius: 22, background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 26, border: 'none', cursor: 'pointer', boxShadow: 'var(--elev-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', zIndex: 50 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #241B17)', margin: 0 },

  typeToggle: { display: 'flex', gap: 8, marginBottom: 14 },

  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #241B17)', background: 'var(--card, #FFFCF9)' },
  colourRow: { display: 'flex', gap: 10 },
  colourDot: { width: 28, height: 28, borderRadius: 16, cursor: 'pointer', border: '2px solid transparent' },

};
