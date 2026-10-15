import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import { renderContentArtwork } from '../lib/content-artwork.js';
import { uploadFile, objectPath, publicUrl, PUBLIC_BUCKET } from '../lib/storage.js';
import { PostPreview } from './ContentStudioHome.jsx';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';
import ContentTeam from './ContentTeam.jsx';

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
export default function ContentAssistant({ owner, onPost, onPrepared, onPosts, onPhotos, onResults, onCompose }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [assetErrors, setAssetErrors] = useState({});
  const [localArtwork, setLocalArtwork] = useState({});
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const alive = useRef(false), generation = useRef(0), locked = useRef(false), assets = useRef(new Map());
  const authGeneration = useRef(0), blocked = useRef(false), operation = useRef(0);

  const current = sequence => alive.current && !blocked.current && sequence === authGeneration.current;
  function assertCurrent(sequence) {
    if (!current(sequence)) throw new Error('Your salon context changed. Reopen Content for your signed-in salon.');
  }
  function clearAssets() {
    for (const asset of assets.current.values()) URL.revokeObjectURL(asset.preview);
    assets.current.clear();
  }
  function blockSession() {
    blocked.current = true; authGeneration.current++; generation.current++; operation.current++;
    locked.current = false; clearAssets();
    setSessionBlocked(true); setBoard(null); setLocalArtwork({}); setAssetErrors({});
    setBusy(false); setLoading(false); setStage(''); setNote(''); setError('');
  }
  async function session(sequence = authGeneration.current) {
    assertCurrent(sequence);
    let timer;
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Your connection is taking too long. Please try again.')), 10000); }),
    ]).finally(() => clearTimeout(timer));
    assertCurrent(sequence);
    if (result.error) throw new Error('We couldn’t check your sign-in. Please try again.');
    if (!result.data?.session?.access_token || !owner.auth_id || result.data.session.user?.id !== owner.auth_id) {
      blockSession(); throw new Error('Your account changed. Reopen Content for your signed-in salon.');
    }
    return result.data.session;
  }
  async function request(path, options = {}, sequence = authGeneration.current) {
    const verified = await session(sequence);
    assertCurrent(sequence);
    const response = await contentRequest(`${API_BASE}/api/content${path}`, { token: verified.access_token, ...options });
    assertCurrent(sequence);
    return response;
  }
  async function refresh() {
    if (blocked.current) return;
    const run = ++generation.current;
    const sequence = authGeneration.current;
    setLoading(true); setError('');
    try {
      const data = checkBoard(await request('/assistant', { timeoutMs: 20000 }, sequence));
      if (current(sequence) && run === generation.current) setBoard(data);
    } catch (err) { if (current(sequence) && run === generation.current) setError(err.message); }
    finally { if (current(sequence) && run === generation.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; refresh();
    const subscription = supabase.auth.onAuthStateChange?.((event, nextSession) => {
      if (!alive.current) return;
      if (event === 'SIGNED_OUT' || (nextSession?.user?.id && nextSession.user.id !== owner.auth_id)) blockSession();
      else if (nextSession?.user?.id === owner.auth_id && blocked.current) {
        blocked.current = false; setSessionBlocked(false);
        queueMicrotask(() => { if (alive.current && !blocked.current) refresh(); });
      }
    });
    return () => {
      alive.current = false; generation.current++; authGeneration.current++; operation.current++;
      subscription?.data?.subscription?.unsubscribe(); clearAssets();
    };
  }, []); // The parent keys by salon; SDK events also invalidate unchanged owner props.

  async function finishArtwork(item, context, sequence) {
    assertCurrent(sequence);
    if (!item.artwork || item.post.image_url || item.post.status !== 'draft') return item;
    const id = item.post_id;
    let asset = assets.current.get(id);
    if (!asset) {
      const output = await renderContentArtwork({ ...item.artwork, businessName: context.business_name || owner.business_name || '', bookingSlug: context.booking_slug || owner.booking_slug || '', format: item.post.media_kind === 'story' ? 'story' : 'feed' });
      assertCurrent(sequence);
      asset = { file: new File([output.blob], output.filename, { type: output.mimeType }), preview: URL.createObjectURL(output.blob) };
      assets.current.set(id, asset);
      setLocalArtwork(previous => ({ ...previous, [id]: asset.preview }));
    }
    // A previous save may have succeeded even if its response was interrupted.
    // Re-read before attaching, and never replace another edit or approved post.
    const latest = await request(`?post_id=${encodeURIComponent(id)}`, { timeoutMs: 15000 }, sequence);
    const post = latest.posts?.find(candidate => candidate.id === id);
    if (!post) throw new Error('Could not check the saved post. Your design is still here.');
    if (post.image_url || post.status !== 'draft') return { ...item, post, needs: (item.needs || []).filter(need => need !== 'photo') };
    if (post.caption !== item.post.caption) throw new Error('This caption has changed since the design was prepared. Review the saved post before adding a design.');
    if (!asset.url) {
      // Storage uses the live SDK session rather than the captured API token.
      // Recheck it immediately before starting this next write.
      await session(sequence); assertCurrent(sequence);
      const uploaded = await uploadFile({ bucket: PUBLIC_BUCKET, path: asset.path || (asset.path = objectPath(owner.id, `content-assistant/${id}`, asset.file.name)), file: asset.file, upsert: true });
      assertCurrent(sequence);
      asset.url = publicUrl(uploaded.path, { bucket: PUBLIC_BUCKET });
      if (!asset.url) throw new Error('Could not confirm the image upload. Your design is still here.');
    }
    const saved = await request(`/${id}`, { method: 'PATCH', body: { image_url: asset.url, artwork_only: true, expected_caption: post.caption } }, sequence);
    if (saved.post?.id !== id || saved.post.image_url !== asset.url) throw new Error('Could not confirm the design was saved. Refresh before trying again.');
    return { ...item, post: saved.post, needs: (item.needs || []).filter(need => need !== 'photo') };
  }

  async function prepare() {
    if (locked.current || !board || loading || blocked.current) return;
    const sequence = authGeneration.current, task = ++operation.current;
    locked.current = true; setBusy(true); setError(''); setNote(''); setAssetErrors({});
    setStage('Checking your sources and preparing up to three posts…');
    try {
      let next = checkBoard(await request('/assistant/prepare', { method: 'POST', body: {}, timeoutMs: 180000 }, sequence));
      setBoard(next);
      const prepared = [...next.prepared];
      const finishable = prepared.map((item, index) => ({item,index})).filter(({item}) => item.artwork && !item.post.image_url && item.post.status === 'draft').slice(0,3);
      for (const { index } of finishable) {
        setStage('Making the designs and saving them with your drafts…');
        try { prepared[index] = await finishArtwork(prepared[index], next, sequence); }
        catch (err) { if (current(sequence)) setAssetErrors(previous => ({ ...previous, [prepared[index].post_id]: err.message })); }
        if (!current(sequence)) return;
      }
      next = { ...next, prepared }; setBoard(next); onPrepared(prepared.map(item => item.post));
      const ready = prepared.filter(item => item.post.status === 'draft' && item.post.image_url && item.post.caption?.trim()).length;
      const issues = (next.errors || []).map(item => typeof item === 'string' ? item : item.message || item.error).filter(Boolean);
      setNote(ready ? `${ready} ${ready === 1 ? 'post is' : 'posts are'} ready for you to review. Nothing has been published.` : 'Your saved work is below, with the remaining details marked. Nothing has been published.');
      if (issues.length) setError(issues.join(' '));
    } catch (err) { if (current(sequence)) setError(`${err.message} Check saved posts before trying again.`); }
    finally { if (current(sequence) && task === operation.current) { locked.current = false; setBusy(false); setStage(''); } }
  }
  async function retryDesign(item) {
    if (locked.current || blocked.current) return;
    const sequence = authGeneration.current, task = ++operation.current;
    locked.current = true; setBusy(true); setStage('Saving your design…');
    try {
      const updated = await finishArtwork(item, board, sequence);
      assertCurrent(sequence);
      setBoard(previous => ({ ...previous, prepared: previous.prepared.map(row => row.post_id === item.post_id ? updated : row) }));
      setAssetErrors(previous => ({ ...previous, [item.post_id]: '' })); onPrepared([updated.post]);
    } catch (err) { if (current(sequence)) setAssetErrors(previous => ({ ...previous, [item.post_id]: err.message })); }
    finally { if (current(sequence) && task === operation.current) { locked.current = false; setBusy(false); setStage(''); } }
  }

  const prepared = board?.prepared || [], opportunities = board?.opportunities || [];
  const needsArtwork = prepared.some(item => item.artwork && !item.post.image_url && item.post.status === 'draft');
  const canPrepare = !board?.unavailable.includes('posts') && ((opportunities.length > 0 && (board?.prepare_capacity ?? Math.max(0, 3-prepared.length)) > 0) || needsArtwork);
  if (sessionBlocked) return <section className="fl-content-team"><div className="fl-team-notice" role="alert">Your account changed. Reopen Content for your signed-in salon.</div></section>;
  return <ContentTeam owner={owner} board={board} loading={loading} busy={busy} stage={stage}
    error={error} note={note} canPrepare={canPrepare} needsArtwork={needsArtwork} onPrepare={prepare}
    onRefresh={refresh} onPosts={onPosts} onPhotos={onPhotos} onResults={onResults} onCompose={onCompose}>
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
  </ContentTeam>;
}
