import './fonts-config.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { supabase } from '../../config.js';

const WIDTH = 1080, HEIGHT = 1350, MARGIN = 72, TEXT_WIDTH = WIDTH - MARGIN * 2;
const CREAM = '#FBF6F1', INK = '#241B17', MAROON = '#92405E', ROSE = '#C76B8A', GOLD = '#C9A96E';
const MAX_BYTES = 20 * 1024 * 1024, MAX_PIXELS = 40 * 1000 * 1000;
const FONTS = {
  title: { family: 'Playfair Display', file: fileURLToPath(new URL('./fonts/PlayfairDisplay.ttf', import.meta.url)) },
  body: { family: 'Plus Jakarta Sans', file: fileURLToPath(new URL('./fonts/PlusJakartaSans.ttf', import.meta.url)) },
};
const fail = message => Object.assign(new Error(message), { status: 503, code: 'artwork_unavailable' });
const digest = data => createHash('sha256').update(data).digest('hex');
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const svg = (width, height, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`);

// Storage paths are checked before downloading. Photo input never causes an
// HTTP fetch to a caller-supplied host, including a redirect or signed URL.
export function contentImagePath(owner, value, supabaseUrl = process.env.SUPABASE_URL) {
  try {
    if (typeof owner !== 'string' || !/^[a-z0-9_-]+$/i.test(owner)) throw new Error();
    const base = new URL(supabaseUrl), url = new URL(value);
    if (url.origin !== base.origin || url.username || url.password || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error();
    const path = decodeURIComponent(url.pathname);
    const prefix = `/storage/v1/object/public/content-images/${owner}/`;
    if (!path.startsWith(prefix) || path.split('/').some(part => part === '.' || part === '..') || /[\\\x00]/.test(path)) throw new Error();
    const key = path.slice('/storage/v1/object/public/content-images/'.length);
    if (!key.slice(owner.length + 1) || key.endsWith('/')) throw new Error();
    return key;
  } catch { throw fail('Choose a photo saved in this salon’s Content library.'); }
}

async function photoBuffer(value, loadImage, sharpImpl) {
  if (!value || !loadImage) throw fail('Choose a saved photo before making this artwork.');
  const input = await loadImage(value);
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_BYTES) throw fail('This photo is too large or could not be read. Try a smaller photo.');
  let metadata;
  try { metadata = await sharpImpl(input, { limitInputPixels: MAX_PIXELS }).metadata(); }
  catch { throw fail('This photo could not be opened. Try a JPEG, PNG or WebP photo.'); }
  if (!['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff', 'gif'].includes(metadata.format) || !metadata.width || !metadata.height)
    throw fail('This photo format cannot be used. Try a JPEG, PNG or WebP photo.');
  return input;
}

async function textLayer(text, { size = 32, maxHeight = 100, width = TEXT_WIDTH, title = false, color = INK, weight = '' } = {}, sharpImpl) {
  if (!String(text || '').trim()) return null;
  const font = title ? FONTS.title : FONTS.body;
  const words = `<span foreground="${color}">${escape(text)}</span>`;
  const minimumSize = title ? 40 : 24;
  // Render at the intended size and only shrink when the complete words need
  // more room. No truncation or ellipsis can silently remove offer terms.
  for (let attempt = 0; attempt < 8; attempt++) {
    const rendered = await sharpImpl({ text: { text: words, font: `${font.family} ${weight} ${size}`.replace(/\s+/g, ' ').trim(),
      fontfile: font.file, width, rgba: true, dpi: 72, wrap: 'word-char', spacing: Math.round(size * .18) } }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.height <= maxHeight && rendered.info.width <= width) return rendered.data;
    const fitted = Math.floor(size * Math.min(maxHeight / rendered.info.height, width / rendered.info.width) * .95);
    if (size <= minimumSize) break;
    size = Math.max(minimumSize, fitted);
  }
  throw fail('There is too much text to fit clearly on this image. Shorten the words and try again.');
}

function flower() {
  const petals = [0, 60, 120, 180, 240, 300].map(angle => `<ellipse cx="24" cy="12" rx="7" ry="11" fill="${ROSE}" transform="rotate(${angle} 24 24)"/>`).join('');
  return svg(48, 48, `${petals}<circle cx="24" cy="24" r="7" fill="${GOLD}"/>`);
}

// Pure apart from the injected image loader. Only sizing, orientation and
// JPEG encoding touch a photo; the whole original image stays in the frame.
export async function renderContentV2Image(post, profile = {}, { loadImage, sharpImpl = sharp } = {}) {
  const media = post.media || {};
  if (media.type === 'photo') {
    const input = await photoBuffer(media.image_url || post.image_url, loadImage, sharpImpl);
    return sharpImpl(input, { limitInputPixels: MAX_PIXELS }).rotate().resize(WIDTH, HEIGHT, { fit: 'contain', background: CREAM })
      .flatten({ background: CREAM }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  }
  const layout = media.layout;
  if (media.type !== 'layout' || !layout || typeof layout !== 'object') throw fail('Choose a photo or a layout before making this artwork.');
  const layers = [];
  const addText = async (text, top, options = {}, left = MARGIN) => {
    const input = await textLayer(text, options, sharpImpl);
    if (input) layers.push({ input, top, left });
  };
  layers.push({ input: flower(), left: MARGIN, top: 64 });
  await addText(profile.business_name || 'Your salon', 71, { size: 28, width: 866, maxHeight: 58 }, 142);
  layers.push({ input: svg(96, 4, `<rect width="96" height="4" fill="${GOLD}"/>`), left: MARGIN, top: 140 });
  const headline = String(layout.headline || layout.title || '');
  const lines = (Array.isArray(layout.lines) ? layout.lines : []).filter(value => value != null && String(value).trim()).map(String);

  if (layout.kind === 'before_after') {
    await addText(headline, 184, { title: true, size: 62, maxHeight: 114 });
    const sources = await Promise.all([photoBuffer(layout.before_url, loadImage, sharpImpl), photoBuffer(layout.after_url, loadImage, sharpImpl)]);
    for (let index = 0; index < sources.length; index++) {
      const top = 326 + index * 438;
      const input = await sharpImpl(sources[index], { limitInputPixels: MAX_PIXELS }).rotate().resize(TEXT_WIDTH, 414, { fit: 'contain', background: CREAM })
        .flatten({ background: CREAM }).png().toBuffer();
      layers.push({ input, left: MARGIN, top });
      layers.push({ input: svg(150, 54, `<rect width="150" height="54" rx="27" fill="${CREAM}"/>`), left: MARGIN + 20, top: top + 20 });
      await addText(index ? 'After' : 'Before', top + 34, { size: 24, width: 116, maxHeight: 32, weight: 'Bold' }, MARGIN + 40);
    }
  } else {
    const eyebrows = { availability: 'APPOINTMENTS', quote: 'KIND WORDS', course: 'TRAINING', treatment: 'YOUR NEXT TREATMENT' };
    const eyebrow = layout.kind === 'offer' ? layout.title : eyebrows[layout.kind];
    await addText(eyebrow || '', 224, { size: 25, color: MAROON, weight: 'Bold', maxHeight: 86 });
    await addText(layout.kind === 'quote' ? `“${headline}”` : headline, 352,
      { title: true, size: layout.kind === 'quote' ? 64 : 78, maxHeight: layout.kind === 'quote' ? 620 : 310 });
    await addText(lines.join('\n\n'), layout.kind === 'quote' ? 1018 : 724,
      { size: 32, maxHeight: layout.kind === 'quote' ? 154 : 458 });
  }
  await addText('Booking link in bio', 1250, { size: 25, maxHeight: 50 });
  return sharpImpl({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: CREAM } }).composite(layers)
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

export async function renderContentV2Artwork(owner, post, profile, { db = supabase, supabaseUrl = process.env.SUPABASE_URL, sharpImpl = sharp } = {}) {
  if (typeof owner !== 'string' || !/^[a-z0-9_-]+$/i.test(owner)) throw fail('Choose a saved salon before making this artwork.');
  const bucket = db.storage.from('content-images');
  const loadImage = async url => {
    const key = contentImagePath(owner, url, supabaseUrl);
    const result = await bucket.download(key);
    if (result.error || !result.data) throw fail('The saved photo could not be downloaded. Try again.');
    if (result.data.size > MAX_BYTES) throw fail('This photo is too large. Try a smaller photo.');
    return Buffer.from(await result.data.arrayBuffer());
  };
  const buffer = await renderContentV2Image(post, profile, { loadImage, sharpImpl });
  const key = `${owner}/content-v2/artwork-${digest(buffer)}.jpg`;
  const saved = await bucket.upload(key, buffer, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (saved.error) {
    if (String(saved.error.statusCode || saved.error.status) !== '409' && saved.error.error !== 'Duplicate' && saved.error.code !== 'Duplicate')
      throw fail('The image could not be saved. Try again.');
    const existing = await bucket.download(key);
    if (existing.error || !existing.data || digest(Buffer.from(await existing.data.arrayBuffer())) !== digest(buffer))
      throw fail('The saved image could not be verified. Try again.');
  }
  const result = bucket.getPublicUrl(key);
  if (result.error || !result.data?.publicUrl || contentImagePath(owner, result.data.publicUrl, supabaseUrl) !== key)
    throw fail('The saved image link could not be read. Try again.');
  return result.data.publicUrl;
}
