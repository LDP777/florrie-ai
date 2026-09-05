import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getVisibleCategories } from '../pages/more-catalog.js';
import { isIOSNative } from '../lib/platform.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

// Every More destination uses the same catalogue and a route back to its peers.
export default function MoreSectionNav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const category = getVisibleCategories(isIOSNative()).find(group => group.items.some(item => pathname === item.path || pathname.startsWith(`${item.path}/`)));
  if (!category) return null;
  return <nav aria-label="More section" style={S.wrap}>
    <div style={S.bar}><Link to={`/more?group=${category.id}`} style={S.back}><Icon name="grid" size={15} /> All tools</Link><span aria-hidden style={{ color: 'var(--text-muted)' }}>/</span>
      <Button variant="quiet" aria-expanded={open} aria-controls="more-related-pages" onClick={() => setOpen(value => !value)} style={S.toggle}>{category.label}<Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} /></Button>
    </div>
    {open && <div id="more-related-pages" style={S.links}>{category.items.map(item => <Link key={item.path} to={item.path} aria-current={pathname === item.path ? 'page' : undefined} style={{ ...S.link, background: pathname === item.path ? 'var(--accent-light)' : 'var(--bg-card)' }}>{item.label}<Icon name="chevron-right" size={14} /></Link>)}</div>}
  </nav>;
}
const S = {
  wrap: { maxWidth: 1040, margin: '0 auto', padding: '4px 20px 0', fontFamily: 'var(--font-body)' },
  bar: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, flexWrap: 'wrap' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textDecoration: 'none' },
  toggle: { minHeight: 44, padding: '6px 0', gap: 6, color: 'var(--accent)', fontSize: 12, whiteSpace: 'normal' },
  links: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 6, background: 'var(--bg-subtle)', borderRadius: 16, padding: 10, margin: '4px 0 12px' },
  link: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44, padding: '8px 12px', borderRadius: 10, color: 'var(--text-primary)', fontSize: 13, textDecoration: 'none' },
};
