import { Link } from 'react-router-dom';
import Icon from '../components/ui/Icon.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import { APP_UPDATES } from './app-updates.js';

const releaseDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

export default function Updates() {
  return <div className="updates-page">
    <style>{styles}</style>
    <div className="updates-topbar">
      <Link to="/more" className="updates-back"><Icon name="chevron-left" size={18} />Back to More</Link>
    </div>
    <PageHeader title="What’s new" subtitle="The latest additions and improvements to Florrie." />
    <div className="updates-history">
      {APP_UPDATES.map(release => <section key={release.date} className="updates-release" aria-labelledby={`release-${release.date}`}>
        <h2 id={`release-${release.date}`} className="updates-date"><time dateTime={release.date}>{releaseDate.format(new Date(`${release.date}T12:00:00Z`))}</time></h2>
        <div className="updates-changes">
          {release.changes.map(change => <article key={change.id} className="updates-change" aria-labelledby={change.id}>
            <h3 id={change.id}>{change.title}</h3>
            <p>{change.description}</p>
            {change.to && <Link to={change.to} className="updates-feature-link">{change.linkLabel}<Icon name="arrow-right" size={16} /></Link>}
          </article>)}
        </div>
      </section>)}
    </div>
  </div>;
}

const styles = `
.updates-page{max-width:860px;margin:0 auto;padding:0 20px var(--scroll-pad-bottom,100px);color:var(--text-primary,#241B17);font-family:var(--font-body,'Plus Jakarta Sans',sans-serif)}
.updates-page *{box-sizing:border-box}
.updates-topbar{display:flex;align-items:center;min-height:64px;padding-right:142px;margin-bottom:12px}
.updates-back{display:inline-flex;align-items:center;gap:3px;min-height:44px;color:var(--accent,#92405e);text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap}
.updates-page>.fl-page-heading{padding-bottom:28px!important}
.updates-page>.fl-page-heading p{line-height:1.6}
.updates-history{padding:0 0 12px 8px}
.updates-release{position:relative;border-left:1px solid var(--border,#e5d9d1);padding:0 0 30px 22px}
.updates-release:last-child{padding-bottom:0;border-color:transparent}
.updates-date{position:relative;margin:0 0 13px;font-size:12px;line-height:20px;font-weight:700;color:var(--accent,#92405e)}
.updates-date:before{content:'';position:absolute;width:7px;height:7px;top:6px;left:-26px;border-radius:50%;background:var(--accent,#92405e);box-shadow:0 0 0 5px var(--bg,#faf7f2)}
.updates-changes{border:1px solid var(--border,#e5d9d1);border-radius:20px;background:var(--surface,#fff);padding:0 20px}
.updates-change{padding:19px 0 12px}
.updates-change+.updates-change{border-top:1px solid var(--border,#e5d9d1)}
.updates-change:last-child{padding-bottom:16px}
.updates-change h3{margin:0 0 7px;font-size:15px;line-height:1.4;font-weight:700;letter-spacing:-.015em}
.updates-change p{margin:0;color:var(--text-secondary,#574A42);font-size:13px;line-height:1.65}
.updates-feature-link{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-top:3px;color:var(--accent,#92405e);font-size:12px;font-weight:650;text-decoration:none}
.updates-page a:focus-visible{outline:3px solid var(--accent,#92405e);outline-offset:3px;border-radius:4px}
@media(hover:hover){.updates-page a:hover{text-decoration:underline;text-underline-offset:4px}}
@media(min-width:700px){.updates-page{padding-left:28px;padding-right:28px}.updates-history{padding-left:12px}.updates-release{padding-left:28px}.updates-date:before{left:-32px}.updates-changes{padding:0 24px}.updates-change{padding-top:22px}.updates-change h3{font-size:16px}.updates-change p{font-size:14px}}
@media(max-width:360px){.updates-page{padding-left:16px;padding-right:16px}.updates-topbar{padding-right:130px}.updates-history{padding-left:4px}.updates-release{padding-left:16px}.updates-date:before{left:-20px}.updates-changes{padding:0 15px}}
`;
