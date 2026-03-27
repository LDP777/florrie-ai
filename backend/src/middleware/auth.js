import { supabaseAnon } from '../index.js';

/**
 * Auth middleware — extracts the Supabase JWT from Authorization header,
 * verifies it, and attaches the beautician record to req.
 */
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get the beautician record linked to this auth user
    const { data: beautician, error: bError } = await supabaseAnon
      .from('beauticians')
      .select('*')
      .eq('auth_id', user.id)
      .single();

    if (bError || !beautician) {
      return res.status(403).json({ error: 'No beautician profile found. Complete onboarding first.' });
    }

    req.user = user;
    req.beautician = beautician;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}
