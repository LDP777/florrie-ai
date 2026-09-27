import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { contentBookingUrl } from '../services/content-booking-results.js';

const router = Router();
const handle = fn => async (req,res) => {
  try { await fn(req,res); } catch { res.status(503).json({error:'Could not complete this request. Check the saved result before trying again.'}); }
};
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);

router.get('/results', requireAuth, handle(async (req, res) => {
  const { data, error } = await supabase.rpc('content_booking_results', { p_owner: req.beautician.id });
  if (error || !Array.isArray(data) || data.length>=1000) return res.status(503).json({ error: 'Booking results could not be loaded. Try again.' });
  res.json({ days:90, campaigns:data.map(r => ({ ...r, url:contentBookingUrl(req.beautician.booking_slug,r.token) })),
    explanation:'Bookings made through these links in the last 90 days. Other bookings and social views are not tracked. Booking value is not money collected.' });
}));

router.post('/:id/booking-link', requireAuth, handle(async (req, res) => {
  if (!uuid(req.params.id)) return res.status(400).json({ error:'Choose a saved post.' });
  const owner = req.beautician.id;
  const post = await supabase.from('content_posts').select('id,post_type').eq('id',req.params.id).eq('beautician_id',owner).maybeSingle();
  if (post.error) return res.status(503).json({error:'Could not check this post.'});
  if (!post.data || post.data.post_type==='gallery') return res.status(404).json({error:'Post not found.'});
  if (!contentBookingUrl(req.beautician.booking_slug,'0'.repeat(32))) return res.status(409).json({error:'Set up your booking page first.'});
  const saved = await supabase.from('content_campaigns').upsert({beautician_id:owner,post_id:req.params.id},{onConflict:'post_id',ignoreDuplicates:true});
  if (saved.error) return res.status(503).json({error:'Could not prepare the booking link. Try again.'});
  const read = await supabase.from('content_campaigns').select('token').eq('post_id',req.params.id).eq('beautician_id',owner).single();
  const url = contentBookingUrl(req.beautician.booking_slug,read.data?.token);
  if (read.error || !url) return res.status(503).json({error:'Could not load the saved booking link. Try again.'});
  res.json({url});
}));

router.post('/review-draft', requireAuth, handle(async (req,res) => {
  const {review_id,expected_text,marketing_permission} = req.body;
  if (!uuid(review_id) || typeof expected_text!=='string' || !expected_text.trim() || expected_text.length>10000 || marketing_permission!==true) {
    return res.status(400).json({error:'Review the feedback and confirm permission to use it in your marketing.'});
  }
  const result=await supabase.rpc('create_review_post',{p_owner:req.beautician.id,p_review:review_id,p_expected:expected_text});
  if (result.error?.code==='22023') return res.status(409).json({error:'This feedback changed or is no longer shareable. Reload it before creating a post.'});
  if (result.error || !result.data?.[0]) return res.status(503).json({error:'Could not save the review draft. Check Drafts before trying again.'});
  res.status(201).json({post:result.data[0]});
}));
export default router;
