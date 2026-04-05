/**
 * Cloudflare Turnstile CAPTCHA widget.
 *
 * Setup (one-time):
 *  1. Go to https://dash.cloudflare.com → Turnstile → Add site
 *  2. Add florrie.ai and app.florrie.ai as hostnames
 *  3. Copy Site Key → VITE_TURNSTILE_SITE_KEY in frontend/.env
 *     (and frontend/.env.production if separate)
 *
 * Usage:
 *  <Turnstile onVerify={(token) => setTurnstileToken(token)} onError={() => setTurnstileToken(null)} />
 *  Then include token as `cf-turnstile-response` in your POST body.
 */
import { useEffect, useRef } from 'react';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export default function Turnstile({ onVerify, onError, onExpire, theme = 'light' }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);

  useEffect(() => {
    // If no site key configured (dev), skip silently
    if (!SITE_KEY) {
      onVerify?.('dev-bypass-token');
      return;
    }

    // Load Turnstile script if not already loaded
    const existingScript = document.getElementById('cf-turnstile-script');
    if (!existingScript) {
      const script = document.createElement('script');
      script.id = 'cf-turnstile-script';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    const renderWidget = () => {
      if (!containerRef.current || widgetIdRef.current !== null) return;
      if (!window.turnstile) return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        theme,
        callback: (token) => onVerify?.(token),
        'error-callback': () => onError?.(),
        'expired-callback': () => {
          onExpire?.();
          onVerify?.(null);
        },
      });
    };

    // If turnstile is already loaded, render immediately
    if (window.turnstile) {
      renderWidget();
    } else {
      // Otherwise wait for script to load
      const script = document.getElementById('cf-turnstile-script');
      script?.addEventListener('load', renderWidget);
    }

    return () => {
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  // Don't render in dev if no site key
  if (!SITE_KEY) return null;

  return <div ref={containerRef} style={{ margin: '12px 0' }} />;
}
