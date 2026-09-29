import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import { renderContentArtwork } from '../lib/content-artwork.js';
import { uploadFile, objectPath, publicUrl, PUBLIC_BUCKET } from '../lib/storage.js';
import { PostPreview } from './ContentStudioHome.jsx';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

const SOURCE = {
  gallery: ['Your saved photos', 'camera'], knowledge: ['Your salon knowledge', 'book'],
  treatment: ['Your treatments', 'sparkles'], booking: ['Your diary', 'calendar'],
  saved_post: ['Your saved work', 'edit'],
};
const sourceLabel = type => (SOURCE[type] || SOURCE.saved_post)[0];
function checkBoard(data) {
  if (!Array.isArray(data?.prepared) || !Array.isArray(data?.opportunities) || !Array.isArray(data?.unavailable)) {
    throw new Error('Florrie couldn’t check your content just now. Your saved posts are still available.');
  }
  return data;
}

/** Read-only on entry. Preparing is explicit; publication keeps the existing approval flow. */
export default function ContentAssistant({ owner, onPost, onPrepared, onPosts, onPhotos, onResults }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [assetErrors, setAssetErrors] = useState({});
  const [localArtwork, setLocalArtwork] = useState({});
  const alive = useRef(false), generation = useRef(0), locked = useRef(false), assets = useRef(new Map());

  async function request(path, options = {}) {
    const { data } = await supabase.auth.getSession();
    if (!alive.current) throw new Error('Content context changed.');
    return contentRequest(`${API_BASE}/api/content${path}`, { token: data?.session?.access_token, ...options });
  }
  async function refresh() {
    const run = ++generation.current;
    setLoading(true); setError('');
    try {
      const data = checkBoard(await request('/assistant', { timeoutMs: 20000 }));
      if (alive.current && run === generation.current) setBoard(data);
    } catch (err) { if (alive.current && run === generation.current) setError(err.message); }
    finally { if (alive.current && run === generation.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; refresh();
    return () => {
      alive.current = false; generation.current++;
      for (const asset of assets.current.values()) URL.revokeObjectURL(asset.preview);
      assets.current.clear();
    };
  }, []); // Parent keys this component by salon. Requests cannot move across accounts.

  async function finishArtwork(item, context) {
    if (!item.artwork || item.post.image_url || item.post.status !== 'draft') return item;
    const id = item.post_id;
    let asset = assets.current.get(id);
    if (!asset) {
      const output = await renderContentArtwork({ ...item.artwork, businessName: context.business_name || owner.business_name || '', bookingSlug: context.booking_slug || owner.booking_slug || '', format: item.post.media_kind === 'story' ? 'story' : 'feed' });
      if (!alive.current) return item;
      asset = { file: new File([output.blob], output.filename, { type: output.mimeType }), preview: URL.createObjectURL(output.blob) };
      assets.current.set(id, asset);
      setLocalArtwork(previous => ({ ...previous, [id]: asset.preview }));
    }
    // A previous save may have succeeded even if its response was interrupted.
    // Re-read before attaching, and never replace another edit or approved post.
    const latest = await request(`?post_id=${encodeURIComponent(id)}`, { timeoutMs: 15000 });
    if (!alive.current) return item;
    const post = latest.posts?.find(candidate => candidate.id === id);
    if (!post) throw new Error('Could not check the saved post. Your design is still here.');
    if (post.image_url || post.status !== 'draft') return { ...item, post, needs: (item.needs || []).filter(need => need !== 'photo') };
    if (post.caption !== item.post.caption) throw new Error('This caption has changed since the design was prepared. Review the saved post before adding a design.');
    if (!asset.url) {
      const uploaded = await uploadFile({ bucket: PUBLIC_BUCKET, path: asset.path || (asset.path = objectPath(owner.id, `content-assistant/${id}`, asset.file.name)), file: asset.file, upsert: true });
      asset.url = publicUrl(uploaded.path, { bucket: PUBLIC_BUCKET });
      if (!asset.url) throw new Error('Could not confirm the image upload. Your design is still here.');
    }
    if (!alive.current) return item;
    const saved = await request(`/${id}`, { method: 'PATCH', body: { image_url: asset.url, artwork_only: true, expected_caption: post.caption } });
    if (!alive.current) return item;
    if (saved.post?.id !== id || saved.post.image_url !== asset.url) throw new Error('Could not confirm the design was saved. Refresh before trying again.');
    return { ...item, post: saved.post, needs: (item.needs || []).filter(need => need !== 'photo') };
  }

  async function prepare() {
    if (locked.current || !board || loading) return;
    locked.current = true; setBusy(true); setError(''); setNote(''); setAssetErrors({});
    setStage('Checking your sources and preparing up to three posts…');
    try {
      let next = checkBoard(await request('/assistant/prepare', { method: 'POST', body: {}, timeoutMs: 180000 }));
      if (!alive.current) return;
      setBoard(next);
      const prepared = [...next.prepared];
      const finishable = prepared.map((item, index) => ({item,index})).filter(({item}) => item.artwork && !item.post.image_url && item.post.status === 'draft').slice(0,3);
      for (const { index } of finishable) {
        setStage('Making the designs and saving them with your drafts…');
        try { prepared[index] = await finishArtwork(prepared[index], next); }
        catch (err) { if (alive.current) setAssetErrors(previous => ({ ...previous, [prepared[index].post_id]: err.message })); }
        if (!alive.current) return;
      }
      next = { ...next, prepared }; setBoard(next); onPrepared(prepared.map(item => item.post));
      const ready = prepared.filter(item => item.post.status === 'draft' && item.post.image_url && item.post.caption?.trim()).length;
      const issues = (next.errors || []).map(item => typeof item === 'string' ? item : item.message || item.error).filter(Boolean);
      setNote(ready ? `${ready} ${ready === 1 ? 'post is' : 'posts are'} ready for you to review. Nothing has been published.` : 'Your saved work is below, with the remaining details marked. Nothing has been published.');
      if (issues.length) setError(issues.join(' '));
    } catch (err) { if (alive.current) setError(`${err.message} Check saved posts before trying again.`); }
    finally { if (alive.current) { locked.current = false; setBusy(false); setStage(''); } }
  }
  async function retryDesign(item) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setStage('Saving your design…');
    try {
      const updated = await finishArtwork(item, board);
      if (!alive.current) return;
      setBoard(previous => ({ ...previous, prepared: previous.prepared.map(row => row.post_id === item.post_id ? updated : row) }));
      setAssetErrors(previous => ({ ...previous, [item.post_id]: '' })); onPrepared([updated.post]);
    } catch (err) { if (alive.current) setAssetErrors(previous => ({ ...previous, [item.post_id]: err.message })); }
    finally { if (alive.current) { locked.current = false; setBusy(false); setStage(''); } }
  }

  const prepared = board?.prepared || [], opportunities = board?.opportunities || [];
  const ready = prepared.filter(item => !item.needs?.length).length;
  const needsArtwork = prepared.some(item => item.artwork && !item.post.image_url && item.post.status === 'draft');
  const canPrepare = !board?.unavailable.includes('posts') && ((opportunities.length > 0 && (board?.prepare_capacity ?? Math.max(0, 3-prepared.length)) > 0) || needsArtwork);
  const campaigns = board?.results?.available && Array.isArray(board.results.campaigns) ? board.results.campaigns : null;
  const confirmed = campaigns?.reduce((sum, row) => sum + (Number.isSafeInteger(Number(row.confirmed)) && Number(row.confirmed) >= 0 ? Number(row.confirmed) : 0), 0);

  return <section className="fl-content-assistant" aria-label="Prepared for you">
    <div className={`fl-assistant-intro ${prepared.length ? 'has-work' : ''}`}>
      <span className="fl-assistant-signature"><Icon name="flower" size={23}/><span>A little less on your list</span></span>
      <h2>{prepared.length ? <>Prepared <em>for you.</em></> : <>Your next posts,<br/><em>taken care of.</em></>}</h2>
      <p>{prepared.length ? `${ready ? `${ready} ready to review. ` : ''}Check the pictures and words, then choose what goes out.` : 'Florrie looks at your photos, treatments and diary, then prepares the pictures and words. You just review what goes out.'}</p>
      {loading && !board ? <p role="status">Checking what your salon has to work with…</p> : canPrepare ? <Button disabled={busy || loading} onClick={prepare}><Icon name="flower" size={19}/>{busy ? 'Preparing your content…' : needsArtwork ? 'Finish my prepared posts' : 'Prepare my next posts'}</Button> : !prepared.length && board && <Button variant="secondary" onClick={onPhotos}><Icon name="camera" size={18}/>Add a photo to get started</Button>}
      {!prepared.length && <small>Drafts first. You choose what gets published.</small>}
    </div>
    {busy && <div className="fl-assistant-progress" role="status"><Icon name="flower" size={22}/><span>{stage}<small>You can leave this page; saved drafts stay in Your posts.</small></span></div>}
    {error && <div className="fl-assistant-error" role="alert"><p>{error}</p><Button variant="quiet" disabled={busy || loading} onClick={refresh}>Refresh prepared work</Button><Button variant="quiet" onClick={onPosts}>Open saved posts</Button></div>}
    {note && <p className="fl-assistant-note" role="status">{note}</p>}
    {board?.unavailable.length > 0 && <details className="fl-assistant-sources"><summary>Some sources couldn’t be checked</summary><p>Florrie won’t use information it couldn’t load. Your saved work remains available.</p><p>{board.unavailable.map(source => ({ diary:'Diary availability', posts:'Saved posts', gallery:'Content photos', treatments:'Treatment details', knowledge:'Salon knowledge', results:'Booking results', sources:'Post sources', photo_usage:'Previous photo use', prepared_sources:'Previously prepared work' }[source] || 'Content source')).join(' · ')}</p><Button variant="quiet" disabled={busy || loading} onClick={refresh}>Check again</Button></details>}

    {prepared.length > 0 && <div className="fl-assistant-work" aria-label="Saved prepared posts">
      <div className="fl-assistant-section-title"><h3>Over to you</h3><Button variant="quiet" onClick={onPosts}>All posts<Icon name="arrow-right" size={15}/></Button></div>
      {prepared.slice(0, 3).map((item, index) => {
        const post = item.post, needs = item.needs || [], local = localArtwork[item.post_id];
        return <article key={item.post_id} className="fl-assistant-post" data-assistant-post={item.post_id}>
          <div className="fl-assistant-preview">{local && !post.image_url ? <img src={local} alt="Prepared design, not yet saved"/> : post.image_url ? <PostPreview post={post}/> : <div className="fl-assistant-missing-art"><Icon name={item.artwork ? 'image' : 'camera'} size={30}/><span>{item.artwork ? 'Design ready to make' : 'Your photo goes here'}</span></div>}</div>
          <div className="fl-assistant-post-copy"><div className="fl-assistant-post-label"><span>{String(index + 1).padStart(2, '0')} / {sourceLabel(item.source?.type)}</span><span>{needs.length ? 'Needs a finishing touch' : 'Ready for review'}</span></div>
            <h3>{item.artwork?.title || (item.source?.type === 'gallery' ? 'Let your work do the talking.' : 'A post for your salon.')}</h3>
            <p className="fl-assistant-caption">{post.caption || 'Add the words you’d like clients to see.'}</p>
            <details><summary>Why this post?</summary><p>{item.reason}</p><p>Prepared from {sourceLabel(item.source?.type).toLowerCase()}. Review the facts and any client-photo permission before publishing.</p></details>
            {assetErrors[item.post_id] && <p role="alert" className="fl-assistant-asset-error">{assetErrors[item.post_id]}</p>}
            <div className="fl-assistant-post-actions">
              <Button disabled={busy} onClick={() => onPost(post)}>{needs.includes('photo') && !item.artwork ? 'Add my photo' : needs.includes('caption') ? 'Finish the caption' : 'Review this post'}<Icon name="arrow-right" size={16}/></Button>
              {item.artwork && !post.image_url && <Button variant="quiet" disabled={busy} onClick={() => retryDesign(item)}>{assetErrors[item.post_id] ? 'Retry saving design' : 'Make the design'}</Button>}
            </div>
          </div>
        </article>;
      })}
    </div>}

    {!prepared.length && opportunities.length > 0 && <div className="fl-assistant-plan" aria-label="What Florrie can prepare"><h3>Here’s what I can work with</h3><p>These are ideas from your salon. Preparing them creates saved drafts.</p>{opportunities.slice(0, 3).map((item, index) => <div key={`${item.type}:${item.source_id}`}><span className="fl-assistant-plan-number">0{index + 1}</span><span><small>{sourceLabel(item.type)}</small><strong>{item.title}</strong><p>{item.reason}</p></span></div>)}</div>}
    {board && !prepared.length && !opportunities.length && !loading && !error && <div className="fl-assistant-plan"><h3>A little to work with first.</h3><p>Add one photo of your work, or save a treatment description. Florrie can turn that into a useful post without asking you to write a brief.</p><Button variant="quiet" onClick={onPhotos}>Add a treatment photo</Button><Link to="/treatments">Update my treatments</Link></div>}

    <div className="fl-assistant-results"><Icon name="trending-up" size={20}/><div><h3>{confirmed > 0 ? `${confirmed} ${confirmed === 1 ? 'booking' : 'bookings'} through your post links` : 'Did it bring anyone through the door?'}</h3><p>{campaigns === null ? 'Booking results couldn’t be checked just now.' : campaigns.length ? 'Confirmed appointments through tracked links in the last 90 days. Other bookings aren’t counted here.' : 'Give a post its own booking link to see which appointments follow. Likes alone won’t tell you that.'}</p></div><Button variant="quiet" onClick={onResults}>View results<Icon name="arrow-right" size={15}/></Button></div>
    <div className="fl-assistant-footnote"><Link to="/reviews"><Icon name="star" size={16}/>Use a client review, with permission<Icon name="chevron-right" size={14}/></Link><span>Florrie uses your saved writing style when it drafts.</span></div>
  </section>;
}
