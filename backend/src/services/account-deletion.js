import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { supabase } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { createDeletionOperations, CleanupReviewRequired } from './account-deletion-operations.js';

export { CleanupReviewRequired };
const hashToken = token => createHash('sha256').update(token).digest('hex');
const LEASE_MS = 15 * 60 * 1000;

export function deletionView(row) {
  return { id: row.id, status: row.status, completed: row.status === 'completed',
    pending_step: row.pending_step, requested_at: row.requested_at,
    message: row.status === 'completed' ? 'Account deletion is complete.'
      : row.status === 'needs_review' ? 'Your deletion request needs a provider cleanup review. Contact support with this reference.'
      : 'Your deletion request is saved. Cleanup is not complete yet and will be retried.' };
}

export function deletionSnapshot(profile, user) {
  const credentials = Object.fromEntries(Object.entries(profile).filter(([key]) => /^(stripe_|subscription_stripe_id$|google_calendar_|instagram_|whatsapp_|xero_|quickbooks_|bird_|sms_inbound_number$)/.test(key)));
  return { ...credentials, beautician_id: profile.id, auth_id: user.id,
    identity_providers: [...new Set([...(user.identities || []).map(identity => identity.provider), ...(user.app_metadata?.providers || [])])] };
}

export function createDeletionStore(db) {
  const checked = async promise => { const { data, error } = await promise; if (error) throw error; return data; };
  return {
    findByToken: token => checked(db.from('account_deletions').select('*').eq('status_token_hash', hashToken(token)).maybeSingle()),
    find: authId => checked(db.from('account_deletions').select('*').eq('auth_id', authId).maybeSingle()),
    get: id => checked(db.from('account_deletions').select('*').eq('id', id).single()),
    create: row => checked(db.from('account_deletions').insert(row).select().single()),
    profile: authId => checked(db.from('beauticians').select('*').eq('auth_id', authId).maybeSingle()),
    pending: () => checked(db.from('account_deletions').select('id').neq('status','completed').order('updated_at').limit(10)),
    async claim(id, token) {
      const now = new Date();
      const rows = await checked(db.from('account_deletions').update({ lease_token: token, lease_until: new Date(+now + LEASE_MS).toISOString(), updated_at: now.toISOString() })
        .eq('id', id).neq('status','completed').or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select());
      return rows?.[0] || null;
    },
    async save(id, token, patch) {
      const rows = await checked(db.from('account_deletions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id',id).eq('lease_token',token).select());
      if (!rows?.length) throw new Error('Deletion lease changed');
      return rows[0];
    },
  };
}

// Each operation must be safe to repeat if it succeeds but its checkpoint fails.
export async function processDeletion(id, { store, operations, decode = decrypt }) {
  const token = randomUUID();
  let row = await store.claim(id, token);
  if (!row) return deletionView(await store.get(id));
  let step = 'snapshot';
  try {
    const snapshot = decode(row.snapshot_encrypted);
    const run = async (name, operation, repeat = false) => {
      if (row.completed_steps?.[name] && !repeat) return;
      step = name;
      row = await store.save(id,token,{ pending_step: name });
      await operation(snapshot, row);
      row = await store.save(id,token,{ completed_steps: { ...row.completed_steps, [name]: true }, last_error: null });
    };
    await run('business', operations.business);
    await run('billing', operations.billing);
    // Auth can refuse deletion if an object appeared after the last inventory.
    // Re-scan until auth removal is confirmed rather than trusting an old pass.
    await run('storage', operations.storage, !row.completed_steps?.auth);
    for (const [provider, operation] of Object.entries(operations.providers)) {
      await run(`provider_${provider}`, async (snapshot, job) => {
        if (job.manual_confirmations?.[provider]?.reference) return;
        await operation(snapshot, job);
      });
    }
    await run('auth', operations.auth);
    row = await store.save(id,token,{ status: 'completed', pending_step: null, last_error: null,
      snapshot_encrypted: null, manual_confirmations: {}, completed_at: new Date().toISOString(), lease_token: null, lease_until: null });
  } catch (err) {
    // Do not persist raw provider errors: they can contain access tokens or PII.
    row = await store.save(id,token,{ status: err instanceof CleanupReviewRequired ? 'needs_review' : 'pending', pending_step: step,
      last_error: err instanceof CleanupReviewRequired ? 'Provider cleanup requires operator confirmation.' : 'Cleanup failed and remains retryable.', lease_token: null, lease_until: null });
  }
  return deletionView(row);
}

export function createAccountDeletionService({ store, operations, encode = encrypt, decode = decrypt }) {
  return {
    status: async user => { const row = await store.find(user.id); return row ? deletionView(row) : null; },
    publicStatus: async token => { const row = await store.findByToken(token); return row ? deletionView(row) : null; },
    async request(user) {
      let row = await store.find(user.id);
      if (!row) {
        const profile = await store.profile(user.id);
        if (!profile) throw new Error('Account profile is unavailable');
        const statusToken = randomBytes(32).toString('base64url');
        const payload = { auth_id: user.id, beautician_id: profile.id, status_token_hash: hashToken(statusToken), snapshot_encrypted: encode({ ...deletionSnapshot(profile,user), status_token: statusToken }) };
        try { row = await store.create(payload); }
        catch (err) { if (err.code !== '23505') throw err; row = await store.find(user.id); if (!row) throw err; }
      }
      if (row.status === 'completed') return deletionView(row);
      const statusToken = decode(row.snapshot_encrypted).status_token;
      return { ...await processDeletion(row.id,{ store,operations,decode }), status_token: statusToken };
    },
    async retryPending() {
      const rows = await store.pending();
      let completed = 0;
      for (const row of rows) {
        const result = await processDeletion(row.id,{ store,operations,decode });
        if (result.completed) completed += 1;
      }
      return { attempted: rows.length, completed };
    },
  };
}

const store = createDeletionStore(supabase);
export const accountDeletion = createAccountDeletionService({ store, operations: createDeletionOperations(supabase),
  encode: snapshot => {
    if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) throw new Error('Account deletion encryption is not configured');
    return encrypt(snapshot);
  },
});
export const retryAccountDeletions = () => accountDeletion.retryPending();
