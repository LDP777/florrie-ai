import { Link, useLocation } from 'react-router-dom';

const links = [['/compliance', 'Overview'], ['/patch-tests', 'Patch tests'], ['/consultation-forms', 'Form templates'], ['/photo-consent', 'Photo consent']];
export default function CareNav() {
  const { pathname } = useLocation();
  return <nav aria-label="Client care" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 22px' }}>
    {links.map(([path, label]) => {
      const active = pathname === path || pathname.startsWith(`${path}/`);
      return <Link key={path} to={path} aria-current={active ? 'page' : undefined} className="fl-btn fl-btn--chip fl-btn--sm"
        style={{ textDecoration: 'none', minHeight: 44, background: active ? 'var(--accent-light)' : 'var(--bg-card)', color: 'var(--accent)', borderColor: 'var(--border)', fontSize: 12 }}>{label}</Link>;
    })}
  </nav>;
}
