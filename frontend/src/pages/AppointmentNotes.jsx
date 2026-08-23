/**
 * Appointment Notes - Per-visit treatment notes, photos & flags.
 *
 * After every appointment Ellie jots down what she used, how it went,
 * anything the client mentioned (pregnancy, allergies, preferences).
 * Next time that client books, she can glance back and know exactly
 * where she left off.
 */
import { useState, useEffect } from 'react';
import { fetchRows, insertRow, updateRow, deleteRow, useBeautician } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import { todayLocal } from '../lib/dates.js';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

export default function AppointmentNotes() {
  const { beautician, loading: bLoading } = useBeautician();
  const [allNotes, setAllNotes] = useState([]);
  const [clients, setClients] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [selectedClient, setSelectedClient] = useState('All');
  const [expandedNote, setExpandedNote] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addForm, setAddForm] = useState({ client: '', treatment: '', notes: '', products: '', flags: '', rating: 5 });
  const [editingNote, setEditingNote] = useState(null);

  async function handleDeleteNote(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await deleteRow('appointment_notes', id);
      setAllNotes(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      logger.error('Failed to delete note:', err);
    }
  }

  function startEditNote(note) {
    setEditingNote(note.id);
    setAddForm({
      client: note.client,
      treatment: note.treatment,
      notes: note.notes,
      products: Array.isArray(note.products) ? note.products.join(', ') : '',
      flags: Array.isArray(note.flags) ? note.flags.join(', ') : '',
      rating: note.rating || 5,
    });
    setShowAdd(true);
  }

  async function handleSaveNote() {
    if (!addForm.client || !addForm.treatment || !addForm.notes) return;
    setSaving(true);
    try {
      const products = addForm.products ? addForm.products.split(',').map(s => s.trim()).filter(Boolean) : [];
      const flags = addForm.flags ? addForm.flags.split(',').map(s => s.trim()).filter(Boolean) : [];

      if (editingNote) {
        // Update existing
        await updateRow('appointment_notes', editingNote, {
          client_name: addForm.client,
          treatment_name: addForm.treatment,
          notes: addForm.notes,
          products,
          flags,
          rating: addForm.rating,
        });
        setAllNotes(prev => prev.map(n => n.id === editingNote ? {
          ...n, client: addForm.client, treatment: addForm.treatment,
          notes: addForm.notes, products, flags, rating: addForm.rating,
        } : n));
      } else {
        // Insert new
        const today = todayLocal();
        const now = new Date().toTimeString().slice(0, 5);
        const created = await insertRow('appointment_notes', {
          beautician_id: beautician.id,
          client_name: addForm.client,
          treatment_name: addForm.treatment,
          notes: addForm.notes,
          products,
          flags,
          rating: addForm.rating,
          date: today,
          time: now,
        });
        setAllNotes(prev => [{
          id: created.id, client: addForm.client, treatment: addForm.treatment,
          date: today, time: now, notes: addForm.notes,
          products, flags, photos: 0, rating: addForm.rating,
        }, ...prev]);
      }
      setShowAdd(false);
      setEditingNote(null);
      setAddForm({ client: '', treatment: '', notes: '', products: '', flags: '', rating: 5 });
    } catch (err) {
      logger.error('Failed to save note:', err);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (bLoading || !beautician) return;
    fetchRows('appointment_notes', beautician.id, { order: 'date', ascending: false })
      .then(rows => setAllNotes(rows.map(r => ({
        id: r.id, client: r.client_name || 'Client', treatment: r.treatment_name || '',
        date: r.date || '', time: r.time || '',
        notes: r.notes || '', products: r.products || [], flags: r.flags || [],
        photos: r.photos || 0, rating: r.rating || 5,
      }))))
      .catch(err => logger.error('Failed to load notes:', err));
    fetchRows('clients', beautician.id).then(r => setClients(r)).catch(() => {});
    fetchRows('treatments', beautician.id, { eq: { is_active: true } }).then(r => setTreatments(r)).catch(() => {});
  }, [beautician, bLoading]);

  const notes = selectedClient === 'All'
    ? allNotes
    : allNotes.filter(n => n.client === selectedClient);

  const clientNames = ['All', ...new Set(allNotes.map(n => n.client))];

  // Group by client for the overview
  const clientSummary = {};
  allNotes.forEach(n => {
    if (!clientSummary[n.client]) clientSummary[n.client] = { count: 0, last: n.date, flags: [] };
    clientSummary[n.client].count++;
    if (n.date > clientSummary[n.client].last) clientSummary[n.client].last = n.date;
    n.flags.forEach(f => { if (!clientSummary[n.client].flags.includes(f)) clientSummary[n.client].flags.push(f); });
  });

  const ratingStars = (r) => '★'.repeat(r) + '☆'.repeat(5 - r);

  return (
    <div style={S.page}>
      <PageHeader
        title="Appointment Notes"
        action={<button style={S.addBtn} onClick={() => setShowAdd(true)}>+ Add Note</button>}
      />

      {/* Quick client flags */}
      {selectedClient === 'All' && (
        <div style={S.flagsOverview}>
          {Object.entries(clientSummary).map(([client, data]) => (
            data.flags.length > 0 && (
              <div key={client} style={S.flagCard}>
                <div style={S.flagCardHeader}>
                  <div style={S.avatar}>{client[0]}</div>
                  <span style={S.flagClient}>{client}</span>
                  <span style={S.flagCount}>{data.count} visits</span>
                </div>
                <div style={S.flagTags}>
                  {data.flags.slice(0, 3).map((f, i) => (
                    <span key={i} style={S.flagTag}>⚑ {f}</span>
                  ))}
                </div>
              </div>
            )
          ))}
        </div>
      )}

      {/* Client filter */}
      <div style={S.filterRow}>
        {clientNames.map(c => (
          <button key={c} onClick={() => setSelectedClient(c)} style={{ ...S.filterChip, ...(selectedClient === c ? S.filterActive : {}) }}>
            {c}
          </button>
        ))}
      </div>

      {/* Notes list */}
      <div style={S.notesList}>
        {notes.map(note => {
          const expanded = expandedNote === note.id;
          return (
            <div key={note.id} style={S.noteCard} onClick={() => setExpandedNote(expanded ? null : note.id)}>
              <div style={S.noteHeader}>
                <div style={S.noteLeft}>
                  <div style={S.avatar}>{note.client[0]}</div>
                  <div style={S.noteInfo}>
                    <span style={S.noteClient}>{note.client}</span>
                    <span style={S.noteTreatment}>{note.treatment}</span>
                  </div>
                </div>
                <div style={S.noteRight}>
                  <span style={S.noteDate}>{formatDate(note.date)}</span>
                  <span style={S.noteTime}>{note.time}</span>
                </div>
              </div>

              {/* Preview line */}
              {!expanded && (
                <p style={S.notePreview}>{note.notes.slice(0, 80)}...</p>
              )}

              {/* Expanded */}
              {expanded && (
                <div style={S.noteExpanded}>
                  <p style={S.noteBody}>{note.notes}</p>

                  {/* Products */}
                  {note.products.length > 0 && (
                    <div style={S.section}>
                      <span style={S.sectionLabel}>Products Used</span>
                      <div style={S.chipRow}>
                        {note.products.map((p, i) => (
                          <span key={i} style={S.productChip}>{p}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Flags */}
                  {note.flags.length > 0 && (
                    <div style={S.section}>
                      <span style={S.sectionLabel}>Flags & Reminders</span>
                      <div style={S.chipRow}>
                        {note.flags.map((f, i) => (
                          <span key={i} style={S.flagChip}>⚑ {f}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Photos & Rating */}
                  <div style={S.metaRow}>
                    {note.photos > 0 && <span style={S.metaItem}>📷 {note.photos} photo{note.photos > 1 ? 's' : ''}</span>}
                    <span style={S.metaItem}>{ratingStars(note.rating)}</span>
                  </div>

                  <div style={S.actionRow}>
                    <button style={S.actionBtn} onClick={(e) => { e.stopPropagation(); startEditNote(note); }}>Edit</button>
                    <button style={{ ...S.actionBtn, color: 'var(--accent, #92405e)' }} onClick={(e) => { e.stopPropagation(); handleDeleteNote(note.id); }}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add note modal */}
      {showAdd && (
        <div style={S.overlay} onClick={() => { setShowAdd(false); setEditingNote(null); setAddForm({ client: '', treatment: '', notes: '', products: '', flags: '', rating: 5 }); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>{editingNote ? 'Edit Note' : 'New Appointment Note'}</h2>

            <div style={S.fieldLabel}>Client</div>
            <select style={S.select} value={addForm.client} onChange={e => setAddForm(f => ({ ...f, client: e.target.value }))}>
              <option value="">Select client</option>
              {clients.map(c => <option key={c.id} value={c.first_name}>{c.first_name} {c.last_name}</option>)}
            </select>

            <div style={S.fieldLabel}>Treatment</div>
            <select style={S.select} value={addForm.treatment} onChange={e => setAddForm(f => ({ ...f, treatment: e.target.value }))}>
              <option value="">Select treatment</option>
              {treatments.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>

            <div style={S.fieldLabel}>Notes</div>
            <textarea style={S.textarea} rows={4} placeholder="What happened during the appointment..." value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} />

            <div style={S.fieldLabel}>Products Used (comma-separated)</div>
            <input style={S.input} placeholder="e.g. Medium brown dye, Lash lift lotion" value={addForm.products} onChange={e => setAddForm(f => ({ ...f, products: e.target.value }))} />

            <div style={S.fieldLabel}>Flags / Reminders (comma-separated)</div>
            <input style={S.input} placeholder="e.g. Allergic to latex, Wants darker shade next" value={addForm.flags} onChange={e => setAddForm(f => ({ ...f, flags: e.target.value }))} />

            <div style={S.fieldLabel}>Rating</div>
            <div style={S.ratingRow}>
              {[1, 2, 3, 4, 5].map(r => (
                <button key={r} onClick={() => setAddForm(f => ({ ...f, rating: r }))} style={{ ...S.starBtn, color: r <= addForm.rating ? 'var(--accent, #92405e)' : 'var(--border, var(--border, #E8DDD4))' }}><Icon name="star" size={15} /></button>
              ))}
            </div>

            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={handleSaveNote}>
              {saving ? 'Saving…' : editingNote ? 'Update Note' : 'Save Note'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  addBtn: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: 'none', borderRadius: 22, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Client flags overview
  flagsOverview: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  flagCard: { background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: 12 },
  flagCardHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  flagClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))', flex: 1 },
  flagCount: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  flagTags: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  flagTag: { padding: '4px 10px', borderRadius: 10, background: '#FFF5E6', color: 'var(--gold, #79581C)', fontSize: 11, fontWeight: 500 },

  avatar: { width: 32, height: 32, borderRadius: 16, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0 },

  filterRow: { display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' },
  filterChip: { padding: '6px 14px', borderRadius: 16, border: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))', background: 'var(--card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterActive: { background: 'var(--text-primary, #241B17)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--text-primary, #241B17)' },

  // Notes list
  notesList: { display: 'flex', flexDirection: 'column', gap: 10 },
  noteCard: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14, cursor: 'pointer' },
  noteHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  noteLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  noteInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  noteClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  noteTreatment: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  noteRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  noteDate: { fontSize: 12, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  noteTime: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  notePreview: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '8px 0 0', lineHeight: 1.4 },

  // Expanded
  noteExpanded: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))' },
  noteBody: { fontSize: 14, color: 'var(--text, var(--text-primary, #241B17))', lineHeight: 1.5, margin: '0 0 12px' },
  section: { marginBottom: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted, var(--text-muted, #6B5D54))', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  productChip: { padding: '4px 10px', borderRadius: 10, background: 'var(--border, var(--border, var(--border, #E8DDD4)))', color: 'var(--text-secondary, #574A42)', fontSize: 12 },
  flagChip: { padding: '4px 10px', borderRadius: 10, background: '#FFF5E6', color: 'var(--gold, #79581C)', fontSize: 12 },
  metaRow: { display: 'flex', gap: 16, marginBottom: 12 },
  metaItem: { fontSize: 13, color: 'var(--accent, #92405e)' },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '8px 0', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', marginBottom: 6, marginTop: 12 },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', background: 'var(--bg-card, #FFFCF9)', outline: 'none', boxSizing: 'border-box' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #E8DDD4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  ratingRow: { display: 'flex', gap: 8 },
  starBtn: { background: 'none', border: 'none', fontSize: 28, cursor: 'pointer', padding: 0 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
