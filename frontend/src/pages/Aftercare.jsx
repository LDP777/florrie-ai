import { useState, useEffect, useRef } from 'react';
import { useBeautician, fetchRowsStrict, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import Icon, { iconName } from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import MoreLoadError from '../components/MoreLoadError.jsx';
// Legacy care cards are saved guidance, not the executor's aftercare_messages.
// Preserve existing preferences without claiming these cards schedule delivery.

export default function Aftercare() {
  const { beautician, loading: bLoading } = useBeautician();
  const [cards, setCards] = useState([]);
  const [tab, setTab] = useState('cards');
  const [loading, setLoading] = useState(true);
  const [selectedCard, setSelectedCard] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const busy = useRef(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // New card form state
  const [newCard, setNewCard] = useState({
    treatment_name: '', icon: 'sparkles', instructions: [{ title: '', text: '' }],
    products: [''], personal_note: '', send_after_hours: 1, auto_send: false,
    rebook_nudge_days: 28,
  });

  useEffect(() => {
    if (beautician) loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const rows = await fetchRowsStrict('aftercare_cards', beautician?.id, { order: 'created_at', ascending: false });
      setCards(rows);
    } catch (err) {
      logger.error('Aftercare load error:', err);
      setLoadError('Could not load your care cards. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleAddInstruction() {
    setNewCard(prev => ({
      ...prev,
      instructions: [...prev.instructions, { title: '', text: '' }],
    }));
  }

  function handleRemoveInstruction(idx) {
    setNewCard(prev => ({
      ...prev,
      instructions: prev.instructions.filter((_, i) => i !== idx),
    }));
  }

  function handleInstructionChange(idx, field, value) {
    setNewCard(prev => ({
      ...prev,
      instructions: prev.instructions.map((inst, i) => i === idx ? { ...inst, [field]: value } : inst),
    }));
  }

  function handleAddProduct() {
    setNewCard(prev => ({ ...prev, products: [...prev.products, ''] }));
  }

  function handleProductChange(idx, value) {
    setNewCard(prev => ({
      ...prev,
      products: prev.products.map((p, i) => i === idx ? value : p),
    }));
  }

  async function handleSaveCard() {
    if (!beautician || busy.current) return;
    if (!newCard.treatment_name.trim() || !newCard.instructions.length || newCard.instructions.some(i => !i.title.trim() || !i.text.trim())) {
      setError('Add a treatment name and a title and instruction for each step.'); return;
    }
    busy.current = true; setSaving(true); setError(null);
    try {
      const saved = await insertRow('aftercare_cards', {
        ...newCard, beautician_id: beautician.id,
        treatment_name: newCard.treatment_name.trim(),
        products: newCard.products.map(p => p.trim()).filter(Boolean), auto_send: false,
      });
      if (!saved?.id) throw new Error('Save was not confirmed');
      setCards(prev => [saved, ...prev]);
      setNewCard({ treatment_name: '', icon: 'sparkles', instructions: [{ title: '', text: '' }],
        products: [''], personal_note: '', send_after_hours: 1, auto_send: false, rebook_nudge_days: 28 });
      setShowCreateForm(false);
    } catch (err) {
      logger.error('Save aftercare card error:', err);
      setError('Could not save this care card. Your instructions are still here. Try again.');
    } finally { busy.current = false; setSaving(false); }
  }

  function openPreview(card) {
    setSelectedCard(card);
    setShowPreview(true);
  }

  const ICON_OPTIONS = ['sparkles', 'eye', 'edit', 'sparkle', 'hand', 'flower', 'spray', 'heart', 'star', 'palette'];

  if (bLoading) return <PageLoader />;
  if (loadError) return <MoreLoadError title="Aftercare" message={loadError} onRetry={loadData} />;

  return (
    <div style={styles.page}>
      {error && <p role="alert" style={{ color: 'var(--danger, #9f3434)' }}>{error}</p>}
      <PageHeader title="Aftercare" subtitle="Post-treatment care cards" />


      {/* === CARDS TAB === */}
      {tab === 'cards' && (
        <div>
          <div style={styles.statusBar}>
            <span style={styles.statusText}>Automatic sending is not connected to these care cards. Save and preview your guidance here.</span>
            <span style={styles.statusCount}>{cards.length} saved</span>
          </div>

          <Button disabled={saving || loading} onClick={() => setShowCreateForm(!showCreateForm)} style={styles.createBtn}>+ New Care Card</Button>

          {/* Create form */}
          {showCreateForm && (
            <div style={styles.formCard}>
              <h3 style={styles.formTitle}>New Care Card</h3>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Treatment name</label>
                <input disabled={saving}
                  type="text" placeholder="e.g. Lash Lift & Tint"
                  value={newCard.treatment_name}
                  onChange={e => setNewCard(p => ({ ...p, treatment_name: e.target.value }))}
                  style={styles.formInput}
                />
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Icon</label>
                <div style={styles.iconGrid}>
                  {ICON_OPTIONS.map(icon => (
                    <button disabled={saving}
                      key={icon}
                      onClick={() => setNewCard(p => ({ ...p, icon }))}
                      style={{ ...styles.iconBtn,
                        background: newCard.icon === icon ? 'var(--accent-light, #F6E7EC)' : 'var(--bg-card, #FFFCF9)',
                        borderColor: newCard.icon === icon ? 'var(--accent, #92405e)' : 'var(--border-light, #ede7e3)',
                      }}
                    >
                      <Icon name={iconName(icon)} inline />
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Care instructions</label>
                {newCard.instructions.map((inst, idx) => (
                  <div key={idx} style={styles.instructionRow}>
                    <div style={{ flex: 1 }}>
                      <input disabled={saving}
                        type="text" placeholder="e.g. First 24 hours"
                        value={inst.title}
                        onChange={e => handleInstructionChange(idx, 'title', e.target.value)}
                        style={{ ...styles.formInput, marginBottom: 6 }}
                      />
                      <textarea disabled={saving}
                        placeholder="What the client should do..."
                        value={inst.text}
                        onChange={e => handleInstructionChange(idx, 'text', e.target.value)}
                        rows={2}
                        style={styles.formTextarea}
                      />
                    </div>
                    {newCard.instructions.length > 1 && (
                      <button disabled={saving} onClick={() => handleRemoveInstruction(idx)} style={styles.removeBtn}>×</button>
                    )}
                  </div>
                ))}
                <button disabled={saving} onClick={handleAddInstruction} style={styles.addStepBtn}>+ Add step</button>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Recommended products</label>
                {newCard.products.map((product, idx) => (
                  <input disabled={saving}
                    key={idx}
                    type="text" placeholder="e.g. Brow oil"
                    value={product}
                    onChange={e => handleProductChange(idx, e.target.value)}
                    style={{ ...styles.formInput, marginBottom: 6 }}
                  />
                ))}
                <button disabled={saving} onClick={handleAddProduct} style={styles.addStepBtn}>+ Add product</button>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Personal note</label>
                <textarea disabled={saving}
                  placeholder="A warm message in your voice..."
                  value={newCard.personal_note}
                  onChange={e => setNewCard(p => ({ ...p, personal_note: e.target.value }))}
                  rows={2}
                  style={styles.formTextarea}
                />
              </div>

              <div style={styles.formActions}>
                <Button disabled={saving} onClick={handleSaveCard} style={styles.saveBtn}>{saving ? 'Saving…' : 'Save Card'}</Button>
                <Button variant="quiet" disabled={saving} onClick={() => setShowCreateForm(false)} style={styles.cancelBtn}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Card list */}
          {loading ? (
            <p style={styles.loadingText}>Loading care cards...</p>
          ) : cards.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}><Icon name="flower" size={32} /></span>
              <p style={styles.emptyTitle}>No care cards yet</p>
              <p style={styles.emptyDesc}>Create an aftercare card for each treatment to keep your guidance ready to review.</p>
            </div>
          ) : (
            <div style={styles.cardList}>
              {cards.map(card => (
                <div key={card.id} style={styles.aftercareCard}>
                  <div style={styles.cardHeader}>
                    <span style={styles.cardIcon}><Icon name={iconName(card.icon)} inline /></span>
                    <div style={styles.cardHeaderText}>
                      <span style={styles.cardName}>{card.treatment_name}</span>
                      <span style={styles.cardMeta}>
                        {card.instructions.length} steps · Stored auto-send preference: {card.auto_send ? 'on' : 'off'}
                      </span>
                    </div>
                    <span style={{ ...styles.autoSendBadge, background: 'var(--bg-hover, #f3ede9)', color: 'var(--text-secondary, #574A42)' }}>Saved</span>
                  </div>

                  {/* Instruction preview */}
                  <div style={styles.instructionPreview}>
                    {card.instructions.slice(0, 2).map((inst, i) => (
                      <div key={i} style={styles.previewStep}>
                        <span style={styles.stepTitle}>{inst.title}</span>
                        <span style={styles.stepText}>{inst.text.length > 80 ? inst.text.slice(0, 80) + '...' : inst.text}</span>
                      </div>
                    ))}
                    {card.instructions.length > 2 && (
                      <span style={styles.moreSteps}>+{card.instructions.length - 2} more steps</span>
                    )}
                  </div>

                  {card.products && card.products.length > 0 && (
                    <div style={styles.productTags}>
                      {card.products.map((p, i) => (
                        <span key={i} style={styles.productTag}>{p}</span>
                      ))}
                    </div>
                  )}

                  <div style={styles.cardActions}>
                    <button onClick={() => openPreview(card)} style={styles.previewBtn}>Preview</button>
                    <span style={styles.cardMeta}>Sending unavailable</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === PREVIEW MODAL === */}
      {showPreview && selectedCard && (
        <div style={styles.previewOverlay} onClick={() => setShowPreview(false)}>
          <div style={styles.previewModal} onClick={e => e.stopPropagation()}>
            <div style={styles.previewHeader}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Guidance preview</span>
              <button onClick={() => setShowPreview(false)} style={styles.closeBtn}>×</button>
            </div>

            {/* Phone mockup */}
            <div style={styles.phoneMockup}>
              <div style={styles.phoneNotch} />
              <div style={styles.phoneContent}>
                {/* Message bubble */}
                <div style={styles.phoneMessage}>
                  <div style={styles.phoneSender}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>florrie.ai for {beautician?.business_name || beautician?.first_name || 'your salon'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>Just now</span>
                  </div>

                  <p style={styles.phoneText}>
                    Hey lovely! Here's your aftercare guide for today's {selectedCard.treatment_name} <Icon name={iconName(selectedCard.icon)} inline />
                  </p>

                  <div style={styles.phoneCard}>
                    <div style={styles.phoneCardTitle}>
                      <Icon name={iconName(selectedCard.icon)} inline /> {selectedCard.treatment_name} - Aftercare
                    </div>
                    {selectedCard.instructions.map((inst, i) => (
                      <div key={i} style={styles.phoneStep}>
                        <span style={styles.phoneStepTitle}>{inst.title}</span>
                        <span style={styles.phoneStepText}>{inst.text}</span>
                      </div>
                    ))}

                    {selectedCard.products && selectedCard.products.length > 0 && (
                      <div style={styles.phoneProducts}>
                        <span style={styles.phoneProductsTitle}>Recommended products:</span>
                        {selectedCard.products.map((p, i) => (
                          <span key={i} style={styles.phoneProductItem}>· {p}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {selectedCard.personal_note && (
                    <p style={styles.phoneNote}>{selectedCard.personal_note}</p>
                  )}


                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text, #241B17)',
  },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid var(--border, #E8DDD4)', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Status bar
  statusBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderRadius: 10, background: 'var(--bg-card, #FFFCF9)',
    boxShadow: 'var(--elev-1)', marginBottom: 12,
  },
  statusDot: { width: 8, height: 8, borderRadius: 'var(--radius-xs)', flexShrink: 0 },
  statusText: { fontSize: 12, color: 'var(--text-secondary, #574A42)', flex: 1 },
  statusCount: { fontSize: 11, color: 'var(--accent, #92405e)', fontWeight: 600 },

  createBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: 16,
  },

  // Card list
  cardList: { display: 'flex', flexDirection: 'column', gap: 12 },
  aftercareCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)',
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  cardIcon: {
    width: 38, height: 38, borderRadius: 10, background: 'var(--accent-light, #F6E7EC)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, flexShrink: 0,
  },
  cardHeaderText: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  cardMeta: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  autoSendBadge: {
    padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 11, fontWeight: 600,
    flexShrink: 0,
  },

  instructionPreview: {
    padding: '10px 12px', background: 'var(--bg, #FBF6F1)', borderRadius: 10, marginBottom: 10,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  previewStep: { display: 'flex', flexDirection: 'column', gap: 2 },
  stepTitle: { fontSize: 11, fontWeight: 600, color: 'var(--accent, #92405e)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  stepText: { fontSize: 12, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4 },
  moreSteps: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontStyle: 'italic' },

  productTags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  productTag: {
    padding: '4px 10px', borderRadius: 'var(--radius-xs)', background: 'var(--bg-hover, #f3ede9)',
    fontSize: 11, color: 'var(--text-secondary, #574A42)',
  },

  cardActions: { display: 'flex', gap: 8 },
  previewBtn: {
    flex: 1, padding: '8px 0', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  toggleAutoBtn: {
    padding: '8px 16px', borderRadius: 10, border: 'none',
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Form
  formCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 16,
  },
  formTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--text, #241B17)' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginBottom: 6, fontWeight: 500 },
  formInput: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  formTextarea: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', resize: 'vertical',
  },
  formSelect: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--bg-card, #FFFCF9)', boxSizing: 'border-box',
  },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  formActions: { display: 'flex', gap: 8, marginTop: 4 },
  saveBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  cancelBtn: {
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--bg-hover, #f3ede9)', color: 'var(--text-secondary, #574A42)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  iconGrid: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center',
  },
  instructionRow: { display: 'flex', gap: 8, marginBottom: 10 },
  removeBtn: {
    width: 28, height: 28, borderRadius: 16, border: 'none',
    background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)', fontSize: 16,
    cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, marginTop: 4,
  },
  addStepBtn: {
    padding: '6px 12px', borderRadius: 'var(--radius-xs)', border: '1.5px dashed var(--border, #E8DDD4)',
    background: 'transparent', color: 'var(--text-muted, #6B5D54)', fontSize: 12,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Settings
  settingsCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 12,
  },
  settingsSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 14px', color: 'var(--text, #241B17)' },
  settingsRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 0', borderBottom: '1px solid var(--bg, #FBF6F1)',
  },
  settingsLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text, #241B17)' },
  settingsHint: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  settingsSelect: {
    padding: '6px 10px', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)',
  },
  toggle: {
    width: 44, height: 26, borderRadius: 16, border: 'none',
    cursor: 'pointer', position: 'relative', flexShrink: 0,
    transition: 'background 0.2s',
  },
  toggleDot: {
    width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: 'var(--elev-1)',
  },

  // Preview modal
  previewOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    zIndex: 960, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20,
  },
  previewModal: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, width: '100%', maxWidth: 380,
    maxHeight: '85vh', overflowY: 'auto', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' },
  previewHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px', borderBottom: '1px solid var(--border, #E8DDD4)',
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 16, border: 'none',
    background: 'var(--bg-hover, #f3ede9)', fontSize: 16, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Phone mockup
  phoneMockup: {
    background: 'var(--border, #E8DDD4)', padding: '12px 10px', borderRadius: '0 0 16px 16px',
  },
  phoneNotch: {
    width: 60, height: 4, borderRadius: 'var(--radius-xs)', background: 'var(--text-muted, #6B5D54)',
    margin: '0 auto 12px',
  },
  phoneContent: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 12 },
  phoneMessage: {},
  phoneSender: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 8,
  },
  phoneText: { fontSize: 13, color: 'var(--text, #241B17)', lineHeight: 1.5, margin: '0 0 10px' },
  phoneCard: {
    background: 'var(--bg, #FBF6F1)', borderRadius: 10, padding: 12, marginBottom: 10,
    border: '1px solid var(--border, #E8DDD4)',
  },
  phoneCardTitle: {
    fontSize: 13, fontWeight: 600, color: 'var(--text, #241B17)', marginBottom: 10,
    paddingBottom: 8, borderBottom: '1px solid var(--border, #E8DDD4)',
  },
  phoneStep: {
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: '8px 0', borderBottom: '1px solid var(--bg-hover, #f3ede9)',
  },
  phoneStepTitle: { fontSize: 11, fontWeight: 600, color: 'var(--accent, #92405e)' },
  phoneStepText: { fontSize: 12, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4 },
  phoneProducts: {
    marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border, #E8DDD4)',
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  phoneProductsTitle: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #574A42)', marginBottom: 2 },
  phoneProductItem: { fontSize: 12, color: 'var(--text-secondary, #574A42)' },
  phoneNote: {
    fontSize: 13, color: 'var(--text, #241B17)', lineHeight: 1.5, margin: '0 0 8px',
    fontStyle: 'italic',
  },
  phoneRebook: {
    padding: '10px 12px', borderRadius: 10, background: 'var(--accent-light, #F6E7EC)',
    fontSize: 12, color: 'var(--accent, #92405e)', fontWeight: 500, textAlign: 'center',
  },

  // Empty / loading
  loadingText: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: 0, lineHeight: 1.5 },
};
