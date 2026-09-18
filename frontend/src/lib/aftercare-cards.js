// Draft care cards are independent of delivery settings and approved AI answers.
export function newCareCardDraft() {
  return { treatment_name: '', icon: 'sparkles', instructions: [{ title: '', text: '' }], products: [''], personal_note: '' };
}

function normaliseCareCard(card) {
  return {
    ...card,
    treatment_name: String(card.treatment_name || ''),
    icon: card.icon || 'sparkles',
    instructions: Array.isArray(card.instructions)
      ? card.instructions.map(step => typeof step === 'object' && step !== null
        ? { ...step, title: String(step.title || ''), text: String(step.text || '') }
        : { title: '', text: String(step || '') })
      : [],
    products: Array.isArray(card.products) ? card.products.map(String) : [],
    personal_note: String(card.personal_note || ''),
  };
}

export function careCardView(card) {
  const view = normaliseCareCard(card);
  return {
    ...view,
    instructions: view.instructions.filter(step => step.title.trim() || step.text.trim()),
    products: view.products.filter(product => product.trim()),
  };
}

export function careCardDraft(card) {
  const view = normaliseCareCard(card);
  return {
    treatment_name: view.treatment_name, icon: view.icon, personal_note: view.personal_note,
    instructions: view.instructions.length ? view.instructions : [{ title: '', text: '' }],
    products: view.products.length ? view.products : [''],
  };
}

function contentForSave(draft) {
  if (!draft.treatment_name?.trim() || !draft.instructions?.length
      || draft.instructions.some(step => !step.title?.trim() || !step.text?.trim())) {
    const error = new Error('Add a treatment name and a title and instruction for each step.');
    error.code = 'CARE_CARD_VALIDATION'; throw error;
  }
  return {
    treatment_name: draft.treatment_name.trim(), icon: draft.icon || 'sparkles',
    instructions: draft.instructions.map(step => ({ ...step, title: step.title.trim(), text: step.text.trim() })),
    products: (draft.products || []).map(product => product.trim()).filter(Boolean),
    personal_note: draft.personal_note || '',
  };
}

export function isCareStorageUnavailable(error) {
  return ['PGRST205', '42P01', '42703', 'PGRST204'].includes(error?.code);
}

export async function loadCareCards(client, beauticianId) {
  if (!beauticianId) throw new Error('Sign in to open your care cards.');
  const { data, error } = await client.from('aftercare_cards')
    .select('id,beautician_id,treatment_name,icon,instructions,products,personal_note,auto_send,send_after_hours,rebook_nudge_days,archived_at,created_at,updated_at')
    .eq('beautician_id', beauticianId).order('created_at', { ascending: false });
  if (error) throw error;
  // The editor needs the migration's version and archive fields. An older,
  // incomplete table must not masquerade as ready storage.
  if ((data || []).some(row => !('archived_at' in row) || !('updated_at' in row))) {
    const error = new Error('Care-card storage is not ready.'); error.code = 'PGRST204'; throw error;
  }
  return data || [];
}

async function updateOwnedCard(client, beauticianId, card, changes) {
  if (!beauticianId || !card?.id || card.beautician_id !== beauticianId) {
    throw new Error('This care card is not available in your salon.');
  }
  if (!card.updated_at) throw new Error('Reload this care card before making changes.');
  const { data, error } = await client.from('aftercare_cards').update(changes)
    .eq('id', card.id).eq('beautician_id', beauticianId).eq('updated_at', card.updated_at)
    .select().single();
  if (error?.code === 'PGRST116') {
    const conflict = new Error('This care card changed elsewhere. Reload the page before trying again.');
    conflict.code = 'CARE_CARD_CONFLICT'; throw conflict;
  }
  if (error) throw error;
  if (!data || data.id !== card.id || data.beautician_id !== beauticianId) throw new Error('The change was not confirmed.');
  return data;
}

export async function saveCareCard(client, beauticianId, draft, existing = null) {
  if (!beauticianId) throw new Error('Sign in to save your care card.');
  const content = contentForSave(draft);
  if (existing) return updateOwnedCard(client, beauticianId, existing, content);
  const { data, error } = await client.from('aftercare_cards')
    .insert({ ...content, beautician_id: beauticianId, auto_send: false }).select().single();
  if (error) throw error;
  if (!data?.id || data.beautician_id !== beauticianId) throw new Error('The save was not confirmed.');
  return data;
}

export function setCareCardArchived(client, beauticianId, card, archived) {
  return updateOwnedCard(client, beauticianId, card, { archived_at: archived ? new Date().toISOString() : null });
}
