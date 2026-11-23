import { useEffect, useState } from 'react';
import Icon from '../ui/Icon.jsx';
import { useClientPrivacy } from '../../contexts/ClientPrivacyContext.jsx';
import { asArray, postImage, postTitle } from './content-view.js';

export function ContentImage({ post, className = '', alt = '' }) {
  const { hidden } = useClientPrivacy();
  const [failed, setFailed] = useState(false);
  const source = postImage(post);
  useEffect(() => setFailed(false), [source]);
  return <span className={`cv2-image ${className}`}>{hidden ? <Icon name="eye-off" size={24}/> : source && !failed ? <img src={source} alt={alt} onError={() => setFailed(true)}/> : <span className="cv2-image-empty"><Icon name="image" size={24}/><span>{failed ? 'Image could not load' : 'Artwork is being prepared'}</span></span>}</span>;
}

function Highlight({ text, changes, active }) {
  const words = active ? asArray(changes).map(change => change.to || change.after || change.new_text).filter(value => typeof value === 'string' && value) : [];
  if (!words.length) return text;
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.split(new RegExp(`(${escaped.join('|')})`, 'g')).map((part, index) => words.includes(part) ? <mark key={index}>{part}</mark> : part);
}
export default function ContentPostPreview({ post, owner, compact = false }) {
  const { hidden } = useClientPrivacy();
  const [highlight, setHighlight] = useState(true);
  useEffect(() => { setHighlight(true); const timer = setTimeout(() => setHighlight(false), 15000); return () => clearTimeout(timer); }, [post.id, post.version]);
  const handle = owner?.instagram_username || owner?.instagram_handle || owner?.business_name || 'Your salon';
  return <article className={`cv2-preview${compact ? ' is-compact' : ''}`} aria-label={hidden ? 'Post details hidden' : 'Post preview'}>
    <header className="cv2-preview-head"><span className="cv2-avatar"><img src="/florrie-petal.svg" alt=""/></span><span><strong>{hidden ? 'Your salon' : handle}</strong><small>{post.channel === 'google' || post.platform === 'google' ? 'Google Business Profile' : 'Instagram · Feed post'}</small></span></header>
    <ContentImage post={post} alt={hidden ? '' : postTitle(post)}/>
    <div className="cv2-preview-copy"><div className="cv2-preview-icons" aria-hidden="true"><Icon name="heart" size={21}/><Icon name="message" size={21}/><Icon name="send" size={21}/></div>
      {hidden ? <p>Show client details to read this post.</p> : <><p><strong>{handle}</strong>{' '}<Highlight text={post.caption || ''} changes={post.change_note?.changes} active={highlight}/></p>{asArray(post.hashtags).length > 0 && <p className="cv2-hashtags">{post.hashtags.join(' ')}</p>}</>}
    </div>
  </article>;
}
export function FactsCard({ post, onFix, busy }) {
  const { hidden } = useClientPrivacy();
  return <section className="cv2-facts"><h3><Icon name="check-circle" size={18}/>Checked by Florrie</h3>
    {asArray(post.facts).length ? <ul>{post.facts.map((fact, index) => <li key={fact.key || index} className={`is-${fact.status || 'ok'}`}><Icon name={fact.status === 'changed' ? 'refresh' : ['warn','block'].includes(fact.status) ? 'alert-triangle' : 'check'} size={17}/><div><strong>{hidden ? (fact.private_label || 'Details hidden').replace(/£[\d,.]+/g,'••••') : fact.label}</strong>{!hidden && fact.detail && <small>{fact.detail}</small>}<small>{fact.source}{fact.checked_at && ` · Checked ${new Date(fact.checked_at).toLocaleTimeString('en-GB',{hour:'numeric',minute:'2-digit'})}`}</small>{!hidden && fact.status === 'warn' && /patch/i.test(`${fact.key} ${fact.label}`) && <ButtonFix busy={busy} onClick={() => onFix('patch')}/>}</div></li>)}</ul> : <p className="cv2-muted">Facts not checked yet.</p>}
  </section>;
}
import Button from '../ui/Button.jsx';
function ButtonFix({ busy, onClick }) { return <Button variant="quiet" size="sm" disabled={busy} onClick={onClick}>Mention the patch test</Button>; }
