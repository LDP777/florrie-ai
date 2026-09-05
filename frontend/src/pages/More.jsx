import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan, getPlanName } from '../lib/subscription.js';
import { isIOSNative } from '../lib/platform.js';
import Icon, { iconName } from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import { getVisibleCategories, searchCategories, readRecentPages, RECENT_KEY } from './more-catalog.js';

export default function More() {
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'trial';
  const categories = useMemo(() => getVisibleCategories(isIOSNative()), []);
  const [params] = useSearchParams();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set([categories.some(group => group.id === params.get('group')) ? params.get('group') : 'appointments']));
  const [recents, setRecents] = useState(() => readRecentPages(categories));
  const searchInput = useRef(null);
  const searching = Boolean(query.trim());
  const filtered = useMemo(() => searchCategories(categories, query), [categories, query]);
  const resultCount = filtered.reduce((count, category) => count + category.items.length, 0);
  const items = categories.flatMap(category => category.items);
  const featured = ['/compliance', '/consultation-forms'].map(path => items.find(item => item.path === path));
  const allExpanded = categories.every(category => expanded.has(category.id));

  function recordVisit(item) {
    const next = [item, ...readRecentPages(categories).filter(recent => recent.path !== item.path)].slice(0, 6);
    setRecents(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next.map(({ path }) => ({ path })))); } catch { /* Browsing works without storage. */ }
  }
  function clearSearch() { setQuery(''); searchInput.current?.focus(); }
  function toggleCategory(id) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return <div className="more-page">
    <style>{styles}</style>
    <PageHeader title="More" eyebrow="Your business" subtitle="Find the tools for the rest of your day." action={<Link className="more-settings" to="/settings" aria-label="Settings" onClick={() => recordVisit(items.find(item => item.path === '/settings'))}><Icon name={iconName('settings')} size={21} /></Link>} />
    <div className="more-search" role="search">
      <Icon name={iconName('search')} size={21} />
      <input ref={searchInput} type="search" aria-label="Search More tools" placeholder="Search forms, payments, settings…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') clearSearch(); }} />
      {query && <button type="button" className="more-clear" aria-label="Clear search" onClick={clearSearch}><Icon name={iconName('close')} size={18} /></button>}
    </div>
    {!searching && <>
      <section className="more-care" aria-labelledby="more-care-title">
        <div className="more-care-intro"><span className="more-care-mark" aria-hidden="true"><Icon name={iconName('verified_user')} size={26} /></span><div><span className="more-eyebrow">Before the appointment</span><h2 id="more-care-title">A little care, ahead of time.</h2><p>Review client checks and prepare consultation forms.</p></div></div>
        <div className="more-featured">{featured.map(item => <Link key={item.path} to={item.path} onClick={() => recordVisit(item)} className="more-featured-link"><div><span className="more-featured-title">{item.label}</span><span className="more-featured-desc">{item.path === '/compliance' ? 'Patch tests, forms & consent' : 'Build, send & review forms'}</span></div><Icon name={iconName('arrow_forward')} size={19} /></Link>)}</div>
      </section>
      {recents.length > 0 && <section className="more-recents" aria-labelledby="more-recents-title"><h2 id="more-recents-title" className="more-eyebrow">Recently opened</h2><div className="more-recent-list">{recents.map(item => <Link key={item.path} to={item.path} onClick={() => recordVisit(item)} className="more-recent-link"><Icon name={iconName(item.matIcon)} size={16} /><span>{item.label}</span></Link>)}</div></section>}
    </>}
    <div className="more-browse-heading"><div><h2>{searching ? 'Search results' : 'Browse your tools'}</h2><p role="status" aria-live="polite">{searching ? `${resultCount} ${resultCount === 1 ? 'tool' : 'tools'} found` : `${items.length} tools, organised around your business`}</p></div>{!searching && <button type="button" className="more-text-button" onClick={() => setExpanded(allExpanded ? new Set() : new Set(categories.map(category => category.id)))}>{allExpanded ? 'Collapse all' : 'Expand all'}</button>}</div>
    {searching && resultCount === 0 ? <div className="more-empty"><Icon name={iconName('search_off')} size={30} /><h3>No tools found</h3><p>Try “consent”, “messages” or “income”.</p><button type="button" className="more-text-button" onClick={clearSearch}>Clear search</button></div> : <div className="more-category-grid">{filtered.map(category => {
      const open = searching || expanded.has(category.id);
      return <section key={category.id} className={`more-category${open ? ' is-open' : ''}`} aria-labelledby={`more-heading-${category.id}`}><h3 id={`more-heading-${category.id}`} className="more-category-heading">{searching ? <div className="more-category-summary"><CategorySummary category={category} /></div> : <button type="button" className="more-category-toggle" aria-expanded={open} aria-controls={`more-items-${category.id}`} onClick={() => toggleCategory(category.id)}><CategorySummary category={category} /><Icon name={iconName(open ? 'expand_less' : 'expand_more')} size={21} /></button>}</h3><div id={`more-items-${category.id}`} hidden={!open} className="more-items">{category.items.map(item => <ToolLink key={item.path} item={item} plan={plan} onVisit={recordVisit} />)}</div></section>;
    })}</div>}
  </div>;
}
function CategorySummary({ category }) {
  return <><span className="more-category-icon" aria-hidden="true"><Icon name={iconName(category.matIcon)} size={21} /></span><span className="more-category-copy"><span className="more-category-title">{category.label}</span><span className="more-category-description">{category.desc}</span></span></>;
}
function ToolLink({ item, plan, onVisit }) {
  const locked = item.gate && !hasFeature(plan, item.gate);
  return <Link to={item.path} className="more-tool" onClick={() => onVisit(item)}><Icon name={iconName(item.matIcon)} size={19} /><span className="more-tool-copy"><span className="more-tool-title">{item.label}</span><span className="more-tool-description">{item.desc}</span>{locked && <span className="more-plan"><Icon name={iconName('lock')} size={12} />{getPlanName(getRequiredPlan(item.gate))}</span>}</span><Icon name={iconName('chevron_right')} size={18} /></Link>;
}
const styles = `
.more-page{max-width:1040px;margin:0 auto;padding:18px 20px var(--scroll-pad-bottom,100px);min-height:var(--shell-viewport,100vh);color:var(--text-primary,#241B17);font-family:'Plus Jakarta Sans',sans-serif}
.more-page *{box-sizing:border-box}.more-page a{color:inherit;text-decoration:none}.more-page button,.more-page input{font:inherit}.more-page button{cursor:pointer}
.more-page :is(a,button,input):focus-visible{outline:3px solid var(--accent,#92405e);outline-offset:3px}
.more-settings{display:flex;align-items:center;justify-content:center;width:46px;height:46px;border:1px solid var(--border,#e5d9d1);border-radius:50%;background:var(--surface,#fff)}
.more-search{display:flex;align-items:center;gap:10px;min-height:56px;border:1px solid var(--border,#e5d9d1);border-radius:18px;background:var(--surface,#fff);padding:0 6px 0 17px;color:var(--text-secondary,#574A42);margin:4px 0 24px}
.more-search:focus-within{border-color:var(--accent,#92405e);box-shadow:0 0 0 3px var(--accent-wash,#FBF2F5)}
.more-search input{flex:1;min-width:0;width:100%;height:54px;padding:0 5px;border:0;background:transparent;color:var(--text-primary,#241B17);font-size:14px;outline:none}.more-search input::-webkit-search-cancel-button{display:none}
.more-clear{width:44px;height:44px;flex-shrink:0;border:0;border-radius:13px;background:transparent;color:inherit;display:grid;place-items:center}
.more-care{border:1px solid var(--accent-border,#e8c9d4);background:var(--accent-wash,#FBF2F5);border-radius:25px;padding:23px;margin-bottom:26px}
.more-care-intro{display:flex;gap:15px;align-items:flex-start;margin-bottom:20px}.more-care-mark{display:grid;place-items:center;width:49px;height:55px;flex-shrink:0;border-radius:18px 18px 24px 24px;background:var(--accent,#92405e);color:#fff}
.more-eyebrow{display:block;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent,#92405e);margin:0 0 8px}
.more-care h2{font-family:'Playfair Display',Georgia,serif;font-size:25px;font-weight:500;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px}.more-care p{font-size:12px;line-height:1.6;color:var(--text-secondary,#574A42);margin:0}
.more-featured{display:grid;grid-template-columns:1fr 1fr;gap:10px}.more-featured-link{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 18px;background:var(--surface,#fff);border:1px solid var(--border,#e5d9d1);border-radius:16px;min-width:0}.more-featured-link>div{min-width:0}.more-featured-link>svg{flex-shrink:0;color:var(--accent,#92405e)}
.more-featured-title{display:block;font-size:14px;font-weight:750;line-height:1.4}.more-featured-desc{display:block;font-size:11px;line-height:1.5;color:var(--text-secondary,#574A42);margin-top:4px}
.more-recents{margin-bottom:26px}.more-recent-list{display:flex;gap:8px;flex-wrap:wrap}.more-recent-link{display:flex;align-items:center;gap:7px;min-height:44px;padding:9px 13px;border:1px solid var(--border,#e5d9d1);border-radius:14px;font-size:11px;font-weight:600;background:var(--tone-1,#fbf1ea)}.more-recent-link svg{color:var(--accent,#92405e);flex-shrink:0}
.more-browse-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:15px}.more-browse-heading h2{font-size:16px;letter-spacing:-.02em;margin:0 0 5px;font-weight:750}.more-browse-heading p{font-size:11px;line-height:1.5;color:var(--text-secondary,#574A42);margin:0}.more-text-button{border:0;background:transparent;color:var(--accent,#92405e);font-size:11px!important;font-weight:750!important;min-height:44px;padding:10px 4px;flex-shrink:0}
.more-category-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.more-category{border:1px solid var(--border,#e5d9d1);border-radius:19px;background:var(--surface,#fff);overflow:hidden}.more-category-heading{margin:0;font:inherit}
.more-category-toggle,.more-category-summary{width:100%;display:flex;align-items:center;gap:12px;padding:18px 16px;text-align:left;border:0;background:transparent;color:inherit;min-height:83px}.more-category-toggle>svg{flex-shrink:0;color:var(--text-secondary,#574A42)}.more-category-icon{width:40px;height:40px;flex-shrink:0;border-radius:13px;display:grid;place-items:center;background:var(--tone-1,#fbf1ea);color:var(--accent,#92405e)}.more-category-copy{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}.more-category-title{font-size:13px;font-weight:750;line-height:1.3}.more-category-description{font-size:11px;line-height:1.45;font-weight:400;color:var(--text-secondary,#574A42)}
.more-items{padding:0 13px 9px}.more-items[hidden]{display:none}.more-tool{display:flex;align-items:center;gap:12px;min-height:73px;padding:14px 5px;border-top:1px solid var(--border,#e5d9d1)}.more-tool>svg:first-child{flex-shrink:0;color:var(--accent,#92405e)}.more-tool>svg:last-child{flex-shrink:0;color:var(--text-secondary,#574A42)}.more-tool-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.more-tool-title{font-size:12px;line-height:1.4;font-weight:700}.more-tool-description{font-size:11px;line-height:1.5;color:var(--text-secondary,#574A42)}.more-plan{display:flex;align-items:center;gap:4px;align-self:flex-start;font-size:10px;font-weight:600;color:var(--text-secondary,#574A42);padding:4px 7px;border-radius:6px;background:var(--tone-1,#fbf1ea);margin-top:2px}
.more-empty{text-align:center;padding:35px 20px;border:1px dashed var(--border,#e5d9d1);border-radius:20px;color:var(--text-secondary,#574A42)}.more-empty h3{color:var(--text-primary,#241B17);font-size:16px;margin:12px 0 8px}.more-empty p{font-size:13px;line-height:1.6;margin:0}
@media(hover:hover){.more-page a:hover,.more-category-toggle:hover,.more-clear:hover{background:var(--tone-1,#fbf1ea)}.more-text-button:hover{text-decoration:underline}}
@media(min-width:760px){.more-page{padding-top:26px}.more-care{padding:27px}.more-care h2{font-size:30px}.more-featured-link{padding:19px 21px}.more-category-toggle,.more-category-summary{padding:20px}.more-items{padding:0 20px 9px}}
@media(max-width:600px){.more-category-grid{grid-template-columns:1fr}.more-page{padding-left:16px;padding-right:16px}.more-featured{grid-template-columns:1fr}.more-care{padding:18px}.more-care h2{font-size:23px}.more-care-intro{gap:12px}.more-care-mark{width:40px;height:47px}.more-featured-link{padding:14px 15px}.more-featured-desc{margin-top:2px}.more-browse-heading p{max-width:190px}}
@media(prefers-reduced-motion:no-preference){.more-page a,.more-page button{transition:background .15s ease}}
`;
