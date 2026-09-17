import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { learnReply } from '../services/reply-learning.js';
import { KNOWLEDGE_CATEGORIES } from '../lib/knowledge.js';

const router = Router();
const idSchema = z.string().uuid();
const fields = z.object({ category: z.enum(KNOWLEDGE_CATEGORIES), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(5000), replace_entry_id: idSchema.nullable().optional() });
const missing = error => ['42P01','42703','PGRST205','PGRST202'].includes(error?.code);
const unavailable = res => res.status(503).json({ error: 'Learning from replies is temporarily unavailable. Your messages and approved answers still work.' });
router.use(requireAuth, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const limit = rateLimit({ windowMs: 60000, limit: 12, keyGenerator: req => req.beautician.id, standardHeaders: true, legacyHeaders: false, message: { error: 'Give Florrie a moment, then try again.' } });

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('knowledge_suggestions')
    .select('id,source_message_id,status,category,title,content,evidence,created_at')
    .eq('beautician_id', req.beautician.id).in('status', ['pending','processing','retry'])
    .order('created_at', { ascending: false }).limit(30);
  if (error) return unavailable(res);
  res.json({ suggestions: data || [] });
});

router.post('/from-reply/:id', limit, async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Choose a sent reply.' });
  try {
    const suggestion = await learnReply(req.beautician.id, req.params.id);
    if (!suggestion) return res.status(404).json({ error: 'Choose one of your own sent text replies. Failed sends and untouched AI drafts cannot teach Florrie.' });
    return res.json({ suggestion });
  } catch { return unavailable(res); }
});

// A bounded catch-up for replies sent before this release or during an outage.
// Source selection is server-side, tenant-scoped and limited to genuine edits.
router.post('/discover', limit, async (req, res) => {
  const { error: schemaError } = await supabase.from('knowledge_suggestions').select('id').limit(0);
  if (schemaError) return unavailable(res);
  const { data, error } = await supabase.from('messages').select('id,content,send_status')
    .eq('beautician_id', req.beautician.id).eq('direction', 'outbound').in('authored_by', ['human','ai_edited'])
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(30);
  if (error) return unavailable(res);
  const ids = (data || []).filter(row => row.send_status !== 'failed' && row.content?.length >= 20).map(row => row.id);
  const existing = ids.length ? await supabase.from('knowledge_suggestions').select('source_message_id,status,updated_at')
    .eq('beautician_id', req.beautician.id).in('source_message_id', ids) : { data: [], error: null };
  if (existing.error) return unavailable(res);
  const done = new Set((existing.data || []).filter(row => !['retry','processing'].includes(row.status) || Date.now() - Date.parse(row.updated_at) < 60000).map(row => row.source_message_id));
  const selected = ids.filter(id => !done.has(id)).slice(0, 6);
  // Sequential extraction limits provider concurrency. No sends take place.
  void (async () => { for (const id of selected) { try { await learnReply(req.beautician.id, id); } catch {} } })();
  res.status(202).json({ reviewing: selected.length });
});

router.post('/:id/approve', async (req, res) => {
  const parsed = fields.safeParse(req.body);
  if (!idSchema.safeParse(req.params.id).success || !parsed.success) return res.status(400).json({ error: 'Add a topic and an answer, up to 120 and 5000 characters.' });
  const input = parsed.data;
  const { data, error } = await supabase.rpc('approve_knowledge_suggestion', {
    p_owner: req.beautician.id, p_id: req.params.id, p_category: input.category,
    p_title: input.title, p_content: input.content, p_replace: input.replace_entry_id || null,
  });
  if (missing(error)) return unavailable(res);
  if (error?.code === 'P0002') return res.status(404).json({ error: 'That suggestion or answer is no longer available.' });
  if (error?.code === '22023') return res.status(409).json({ error: 'That suggestion has already been handled. Refresh to see your answers.' });
  if (error || !data?.length) return unavailable(res);
  res.json({ entry: data[0] });
});

router.post('/:id/dismiss', async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Choose a suggestion.' });
  const { data, error } = await supabase.from('knowledge_suggestions').update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('beautician_id', req.beautician.id).eq('id', req.params.id).eq('status', 'pending').select('id');
  if (error) return unavailable(res);
  if (!data?.length) return res.status(409).json({ error: 'That suggestion has already been handled.' });
  res.json({ ok: true });
});
export default router;
