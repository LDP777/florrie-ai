import Stripe from 'stripe';
import { decrypt, isEncrypted } from '../lib/crypto.js';
export class CleanupReviewRequired extends Error {
  constructor(message) { super(message); this.name = 'CleanupReviewRequired'; }
}

const missingStripe = err => err?.code === 'resource_missing' && err?.statusCode === 404;
const checked = async promise => { const result = await promise; if (result.error) throw result.error; return result.data; };
const credentialObject = value => typeof value === 'string' && isEncrypted(value) ? decrypt(value) : value;

export async function deleteBilling(snapshot, stripe) {
  const customerId = snapshot.stripe_customer_id;
  const subscriptionId = snapshot.subscription_stripe_id;
  if (!customerId && !subscriptionId) return;
  if (!stripe) throw new Error('Billing cleanup is not configured');
  if (customerId) {
    let customer;
    try { customer = await stripe.customers.retrieve(customerId); }
    catch (err) { if (!missingStripe(err)) throw err; return; }
    if (customer.deleted) return; // Stripe customer deletion cancels subscriptions.
    if (customer.metadata?.beautician_id !== snapshot.beautician_id) throw new CleanupReviewRequired('Billing ownership needs review');
    // Customer deletion cancels every active subscription, including duplicates
    // not reflected by the single subscription ID on the profile.
    const deleted = await stripe.customers.del(customerId);
    if (!deleted?.deleted) throw new Error('Customer deletion was not confirmed');
  } else {
    let sub;
    try { sub = await stripe.subscriptions.retrieve(subscriptionId); }
    catch (err) { if (!missingStripe(err)) throw err; return; }
    if (sub.metadata?.beautician_id !== snapshot.beautician_id) throw new CleanupReviewRequired('Subscription ownership needs review');
    if (sub.status !== 'canceled') {
      const canceled = await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
      if (canceled.status !== 'canceled') throw new Error('Subscription cancellation was not confirmed');
    }
  }
}

export async function deleteStoredObjects(snapshot, db) {
  // A bounded batch leaves large accounts pending rather than monopolising a worker.
  for (let batch=0; batch<10; batch+=1) {
    const objects = await checked(db.rpc('account_deletion_storage_objects', { p_auth_id: snapshot.auth_id, p_beautician_id: snapshot.beautician_id }));
    if (!Array.isArray(objects)) throw new Error('Storage inventory was not confirmed');
    if (!objects.length) return;
    const buckets = new Map();
    for (const object of objects) {
      if (!object.bucket_id || !object.name) throw new Error('Invalid storage inventory');
      const paths = buckets.get(object.bucket_id) || []; paths.push(object.name); buckets.set(object.bucket_id, paths);
    }
    for (const [bucket, paths] of buckets) await checked(db.storage.from(bucket).remove(paths));
  }
  throw new Error('Storage cleanup has more batches to process');
}

export function createDeletionOperations(db, { stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null, request = (...args) => fetch(...args) } = {}) {
  const manual = (provider, present) => async snapshot => { if (present(snapshot)) throw new CleanupReviewRequired(`${provider} access must be revoked and confirmed`); };
  return {
    business: async (_snapshot, job) => { await checked(db.rpc('erase_deletion_business',{ p_deletion_id: job.id })); },
    billing: snapshot => deleteBilling(snapshot,stripe),
    storage: snapshot => deleteStoredObjects(snapshot,db),
    providers: {
      google: async snapshot => {
        const tokens = credentialObject(snapshot.google_calendar_tokens);
        const token = tokens?.refresh_token || tokens?.access_token;
        if (!token) {
          if (snapshot.google_calendar_connected) throw new CleanupReviewRequired('Google connection has no revocable token');
          return;
        }
        const response = await request('https://oauth2.googleapis.com/revoke',{ method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({token}).toString(), signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw new CleanupReviewRequired('Google revocation was not confirmed');
      },
      // These connections need provider-specific, verified revocation support.
      // Clearing a local token or deleting a Supabase user does not revoke them.
      instagram: manual('Instagram', s => !!(s.instagram_page_token || s.instagram_token || s.instagram_page_id)),
      whatsapp: manual('WhatsApp', s => !!(s.whatsapp_token || s.whatsapp_phone_id)),
      accounting: manual('Accounting provider', s => !!(s.xero_tokens || s.xero_tenant_id || s.quickbooks_tokens || s.quickbooks_realm_id)),
      stripe_connect: manual('Stripe Connect', s => !!s.stripe_account_id),
      apple: manual('Apple', s => s.identity_providers?.includes('apple')),
      other_identity: manual('Sign-in provider', s => s.identity_providers?.some(provider => !['apple','email','phone'].includes(provider))),
      sms: manual('SMS channel', s => !!(s.bird_channel_id || s.sms_channel_id || s.sms_inbound_number)),
    },
    auth: async snapshot => {
      const { data, error } = await db.auth.admin.deleteUser(snapshot.auth_id);
      if (error?.code === 'user_not_found' || (error?.status === 404 && error.code === 'not_found')) return;
      if (error) throw error;
      if (data?.user?.id !== snapshot.auth_id) throw new Error('Authentication deletion was not confirmed');
    },
  };
}
