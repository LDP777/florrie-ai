import { useState, useEffect } from 'react';

/**
 * InstallPrompt - shows a native-feeling "Add to Home Screen" banner.
 *
 * Captures the `beforeinstallprompt` event and displays a branded banner
 * when the user has used the app at least 3 times (stored in a simple counter).
 * Dismissable, won't show again once installed or dismissed.
 */

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if already installed or dismissed
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (sessionStorage.getItem('florrie-install-dismissed')) return;

    // Track visit count - show after 3rd visit
    const visits = parseInt(localStorage.getItem('florrie-visit-count') || '0', 10) + 1;
    localStorage.setItem('florrie-visit-count', String(visits));

    if (visits < 3) return;

    function handleBeforeInstall(e) {
      e.preventDefault();
      setDeferredPrompt(e);
      setVisible(true);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
    }
    setDeferredPrompt(null);
  }

  function handleDismiss() {
    setVisible(false);
    sessionStorage.setItem('florrie-install-dismissed', '1');
  }

  if (!visible) return null;

  return (
    <div style={s.banner}>
      <div style={s.content}>
        <img src="/favicon-192.png" alt="Florrie" style={s.icon} />
        <div style={s.text}>
          <span style={s.title}>Add Florrie to your home screen</span>
          <span style={s.desc}>Quick access, works offline, feels like a real app</span>
        </div>
      </div>
      <div style={s.actions}>
        <button onClick={handleInstall} style={s.installBtn}>Install</button>
        <button onClick={handleDismiss} style={s.dismissBtn}>Not now</button>
      </div>
    </div>
  );
}

const s = {
  banner: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: 'var(--bg-card, #fff)',
    borderTop: '1px solid var(--border, #EDE9E4)',
    padding: '14px 16px',
    zIndex: 9999,
    boxShadow: '0 -2px 12px rgba(0,0,0,0.06)',
    animation: 'slideUp 0.3s ease',
  },
  content: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    flexShrink: 0,
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary, #2D2A26)',
  },
  desc: {
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 1,
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  installBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  dismissBtn: {
    padding: '10px 20px',
    borderRadius: 10,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'transparent',
    color: 'var(--text-secondary, #8B6F5E)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
