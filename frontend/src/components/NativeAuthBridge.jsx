import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { isIOSNative } from '../lib/platform.js';
import { supabase } from '../lib/supabase.js';
import { createNativeAuthHandler } from '../lib/native-auth.js';

export default function NativeAuthBridge() {
  const navigate = useNavigate();
  // BrowserRouter changes navigate on route changes. Keep the native listener
  // and its consumed-code set mounted; getLaunchUrl retains the last URL.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!isIOSNative() || !supabase) return;
    let cancelled = false;
    let listener;
    (async () => {
      const [{ App }, { Browser }] = await Promise.all([import('@capacitor/app'), import('@capacitor/browser')]);
      if (cancelled) return;
      const receive = createNativeAuthHandler({ auth: supabase.auth, navigate: (...args) => { if (!cancelled) navigateRef.current(...args); }, closeBrowser: () => Browser.close() });
      listener = await App.addListener('appUrlOpen', ({ url }) => { if (!cancelled) void receive(url); });
      if (cancelled) { await listener.remove(); return; }
      const launch = await App.getLaunchUrl();
      if (!cancelled && launch?.url) await receive(launch.url);
    })().catch(() => {
      if (!cancelled) navigate('/login?auth_error=1', { replace: true });
    });
    return () => { cancelled = true; void listener?.remove(); };
  }, []);
  return null;
}
