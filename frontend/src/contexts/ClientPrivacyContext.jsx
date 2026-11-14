import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/ui/Icon.jsx';

export const CLIENT_PRIVACY_KEY = 'florrie:hide-client-details:v1';
const ClientPrivacyContext = createContext({ hidden: false, toggle: () => {} });

function readPreference() {
  try { return window.localStorage.getItem(CLIENT_PRIVACY_KEY) === 'true'; }
  catch { return false; }
}

// Owner-only display preference. Records, API responses and outgoing payloads
// stay intact. Public booking and client forms are outside this provider.
export function ClientPrivacyProvider({ children }) {
  const [hidden, setHidden] = useState(readPreference);
  const toggle = useCallback(() => setHidden(value => {
    const next = !value;
    try { window.localStorage.setItem(CLIENT_PRIVACY_KEY, String(next)); } catch { /* usable for this session */ }
    return next;
  }), []);

  useEffect(() => {
    const sync = event => {
      if (event.key === CLIENT_PRIVACY_KEY || event.key === null) setHidden(readPreference());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useEffect(() => {
    if (hidden) window.speechSynthesis?.cancel();
  }, [hidden]);

  const value = useMemo(() => ({ hidden, toggle }), [hidden, toggle]);
  return <ClientPrivacyContext.Provider value={value}>{children}</ClientPrivacyContext.Provider>;
}

export function useClientPrivacy() { return useContext(ClientPrivacyContext); }

// Conceal rather than blur: the original is absent from the rendered DOM,
// accessible name and clipboard selection while the eye is switched off.
export function PrivateText({ children, placeholder = 'Hidden', as, ...props }) {
  const { hidden } = useClientPrivacy();
  if (!hidden && !as && Object.keys(props).length === 0) return children;
  const Tag = as || 'span';
  if (!hidden) return <Tag {...props}>{children}</Tag>;
  return <Tag className={props.className} style={props.style} data-client-private="hidden">{placeholder}</Tag>;
}

// Keep payment state outside this wrapper: “Paid”, “Deposit paid” and “Unpaid”
// remain useful while the amount and identifying details are concealed.
export function PrivateAmount({ children, ...props }) {
  return <PrivateText {...props} placeholder="••••">{children}</PrivateText>;
}

export function PrivateSection({ children, placeholder = 'Client details hidden', className = '', style }) {
  const { hidden } = useClientPrivacy();
  if (!hidden) return children;
  return <div className={`client-private-section ${className}`} style={style} data-client-private="hidden">
    <Icon name="eye-off" size={19} />
    <span>{placeholder}<small>Use the eye button to show details again.</small></span>
  </div>;
}

export function ClientPrivacyToggle() {
  const { hidden, toggle } = useClientPrivacy();
  return <button type="button" className={`client-privacy-toggle${hidden ? ' is-hidden' : ''}`}
    aria-label="Hide client details" aria-pressed={hidden}
    title={hidden ? 'Show client details' : 'Hide client details'} onClick={toggle}>
    <Icon name={hidden ? 'eye-off' : 'eye'} size={20} />
  </button>;
}

export function ClientPrivacyStatus() {
  const { hidden } = useClientPrivacy();
  const statusRef = useRef(null);
  useLayoutEffect(() => {
    const element = statusRef.current;
    const shell = element?.closest('.app-shell');
    if (!shell) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const height = hidden ? element.getBoundingClientRect().height + parseFloat(style.marginTop || 0) + parseFloat(style.marginBottom || 0) : 0;
      shell.style.setProperty('--client-privacy-status-height', `${height}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); shell.style.removeProperty('--client-privacy-status-height'); };
  }, [hidden]);
  return <div ref={statusRef} role="status" aria-live="polite" className={hidden ? 'client-privacy-status' : 'client-privacy-status sr-only'}>
    {hidden ? <><Icon name="eye-off" size={16} /><span>Client details hidden <small>On this device</small></span></> : 'Client details visible'}
  </div>;
}
