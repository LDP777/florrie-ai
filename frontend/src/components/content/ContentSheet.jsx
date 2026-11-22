import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Button from '../ui/Button.jsx';
import Icon from '../ui/Icon.jsx';
let locks = 0;
let originalOverflow = '';
const focusable = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]';

export function ContentDialog({ children, onClose, labelId, className = '', initialFocus, focusKey }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    if (locks++ === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    const target = initialFocus?.current || ref.current.querySelector('[data-dialog-heading]') || ref.current;
    target?.focus({ preventScroll: true });
    const keys = event => {
      const dialogs = [...document.querySelectorAll('[data-content-dialog]')];
      if (dialogs.at(-1) !== ref.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...ref.current.querySelectorAll(focusable)].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); ref.current.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keys, true);
    return () => { document.removeEventListener('keydown', keys, true); if (--locks === 0) document.body.style.overflow = originalOverflow; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (focusKey !== undefined) ref.current?.querySelector('[data-dialog-heading]')?.focus({ preventScroll: true }); }, [focusKey]);
  return createPortal(<div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1} data-content-dialog className={`cv2-dialog ${className}`}>{children}</div>, document.body);
}

export default function ContentSheet({ title, onClose, children, footer, wide = false }) {
  const id = useId();
  return <ContentDialog onClose={onClose} labelId={id} className="cv2-sheet-layer">
    <Button variant="quiet" className="cv2-scrim" tabIndex={-1} aria-label="Close sheet" onClick={onClose}/>
    <section className={`cv2-sheet${wide ? ' cv2-sheet-wide' : ''}`}>
      <div className="cv2-sheet-handle" aria-hidden="true"/>
      <header className="cv2-sheet-head"><h2 id={id} tabIndex={-1} data-dialog-heading>{title}</h2><Button variant="quiet" icon aria-label="Close sheet" onClick={onClose}><Icon name="x" size={20}/></Button></header>
      <div className="cv2-sheet-body">{children}</div>
      {footer && <footer className="cv2-sheet-footer">{footer}</footer>}
    </section>
  </ContentDialog>;
}
