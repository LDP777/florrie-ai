const COLOURS = { paper: '#FBF6F1', ink: '#241B17', rose: '#92405E', muted: '#6B5D54', line: '#E8DDD4', wash: '#F6E7EC' };
const KINDS = { treatment: 'From the salon', knowledge: 'A helpful answer', booking: 'Appointments' };
const FORMATS = { feed: { width: 1080, height: 1350, inset: 88 }, story: { width: 1080, height: 1920, inset: 180 } };

function textValue(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} is too long or missing. Shorten it before making the artwork.`);
  const clean = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !clean) throw new Error(`Add ${label.toLowerCase()} before making the artwork.`);
  return clean;
}

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}

function safePhotoUrl(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) throw new Error('Choose a saved photo or upload a new one.');
  if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('This photo link is not valid. Choose another photo.'); }
  if (url.protocol === 'blob:' && url.origin === window.location.origin) return url.href;
  const host = url.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    /^\d+$/.test(host) || /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('[') || host === '0.0.0.0';
  if (url.protocol !== 'https:' || url.username || url.password || privateHost) throw new Error('Use a secure public photo link or a photo you have uploaded.');
  return url.href;
}

async function loadPhoto(value) {
  const source = safePhotoUrl(value);
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  try {
    await bounded(new Promise((resolve, reject) => {
      image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error('The photo is empty. Choose another photo.'));
      image.onerror = () => reject(new Error('Could not load this photo. Upload it again or choose another photo.'));
      image.src = source;
    }), 12000, 'The photo is taking too long to load. Try again or choose another photo.');
    if (image.naturalWidth * image.naturalHeight > 64000000) throw new Error('This photo is too large. Choose a smaller copy.');
    return image;
  } catch (error) {
    image.src = '';
    throw error;
  } finally { image.onload = null; image.onerror = null; }
}

function graphemes(text) {
  return typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment) : Array.from(text);
}

function wrappedLines(context, text, width) {
  if (!text) return [];
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const joined = line ? `${line} ${word}` : word;
      if (context.measureText(joined).width <= width) { line = joined; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of graphemes(word)) {
        if (context.measureText(character).width > width) throw new Error('This text cannot fit on the artwork. Use a shorter title or answer.');
        if (line && context.measureText(line + character).width > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function fitCopy(context, title, body, width, height, fonts) {
  for (let step = 0; step <= 22; step++) {
    const titleSize = Math.max(52, 96 - step * 2);
    const bodySize = Math.max(34, 44 - Math.floor(step / 2));
    context.font = `500 ${titleSize}px ${fonts.display}`;
    const titleLines = wrappedLines(context, title, width);
    context.font = `400 ${bodySize}px ${fonts.body}`;
    const bodyLines = wrappedLines(context, body, width);
    const titleHeight = titleLines.length * titleSize * 1.2;
    const bodyHeight = bodyLines.length * bodySize * 1.5;
    const total = titleHeight + (bodyLines.length ? 34 : 0) + bodyHeight;
    if (total <= height) return { titleLines, bodyLines, titleSize, bodySize, titleHeight, total };
  }
  throw new Error('There is too much text for one image. Shorten the title or answer, or make a second post. Your words have not been changed.');
}

function drawLines(context, lines, x, y, lineHeight) {
  for (const line of lines) { context.fillText(line, x, y); y += lineHeight; }
  return y;
}

/** Render a local, reviewable PNG. This never saves, uploads or publishes it. */
export async function renderContentArtwork({ kind, businessName, title, body = '', bookingSlug = '', photoUrl, format = 'feed' } = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') throw new Error('Open Florrie in the app or a browser to make this artwork.');
  if (!Object.hasOwn(KINDS, kind) || !Object.hasOwn(FORMATS, format)) throw new Error('Choose a supported artwork type and format.');
  const name = textValue(businessName, 'Business name', 120, true);
  const heading = textValue(title, 'Title', 320, true);
  const detail = textValue(body, 'Body text', 2400);
  if (typeof bookingSlug !== 'string' || (bookingSlug && !/^[a-z0-9_-]{1,80}$/i.test(bookingSlug))) throw new Error('The booking address is not valid. Check your booking page first.');
  if (photoUrl != null && photoUrl !== '') safePhotoUrl(photoUrl);
  if (document.fonts?.ready) await bounded(document.fonts.ready, 10000, 'The app fonts are still loading. Try making the artwork again.');
  const tokens = getComputedStyle(document.documentElement);
  const fonts = {
    display: tokens.getPropertyValue('--font-display').trim() || "'Playfair Display', Georgia, serif",
    body: tokens.getPropertyValue('--font-body').trim() || "'Plus Jakarta Sans', -apple-system, sans-serif",
  };
  const image = photoUrl ? await loadPhoto(photoUrl) : null;
  const { width, height, inset } = FORMATS[format];
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This device could not prepare the artwork. Try again in Florrie.');
  const x = 88, contentWidth = width - x * 2, footerY = height - inset - 32;
  context.textBaseline = 'top';
  context.fillStyle = COLOURS.paper; context.fillRect(0, 0, width, height);
  context.strokeStyle = COLOURS.line; context.lineWidth = 2;
  context.strokeRect(34, 34, width - 68, height - 68);
  context.fillStyle = COLOURS.rose;
  let nameSize = 32, nameLines;
  do {
    context.font = `600 ${nameSize}px ${fonts.body}`;
    nameLines = wrappedLines(context, name, contentWidth);
    if (nameLines.length <= 2) break;
    nameSize -= 2;
  } while (nameSize >= 24);
  if (nameLines.length > 2) throw new Error('Shorten your business name for this artwork.');
  let y = drawLines(context, nameLines, x, inset, nameSize * 1.4) + 26;
  context.fillRect(x, y, 70, 4);
  y += 38;
  context.font = `500 26px ${fonts.body}`;
  context.fillStyle = COLOURS.muted; context.fillText(KINDS[kind], x, y);
  y += 58;
  const photoHeight = image ? (format === 'story' ? 530 : 350) : 0;
  const copySpace = footerY - 58 - y - (image ? photoHeight + 34 : 0);
  const copy = fitCopy(context, heading, detail, contentWidth, copySpace, fonts);
  if (!image) y += Math.max(0, (copySpace - copy.total) * .25);
  context.font = `500 ${copy.titleSize}px ${fonts.display}`;
  context.fillStyle = COLOURS.ink;
  y = drawLines(context, copy.titleLines, x, y, copy.titleSize * 1.2);
  if (image) {
    y += 24;
    context.fillStyle = COLOURS.wash; context.fillRect(x, y, contentWidth, photoHeight);
    const scale = Math.min(contentWidth / image.naturalWidth, photoHeight / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    context.drawImage(image, x + (contentWidth - w) / 2, y + (photoHeight - h) / 2, w, h);
    y += photoHeight + 10;
  }
  if (copy.bodyLines.length) {
    y += 34;
    context.font = `400 ${copy.bodySize}px ${fonts.body}`;
    context.fillStyle = COLOURS.muted;
    drawLines(context, copy.bodyLines, x, y, copy.bodySize * 1.5);
  }
  context.strokeStyle = COLOURS.line;
  context.beginPath(); context.moveTo(x, footerY - 24); context.lineTo(width - x, footerY - 24); context.stroke();
  if (bookingSlug) {
    const address = `florrie.ai/book/${bookingSlug}`;
    let footerSize = 26;
    do { context.font = `500 ${footerSize}px ${fonts.body}`; if (context.measureText(address).width <= contentWidth) break; footerSize -= 1; } while (footerSize >= 22);
    if (context.measureText(address).width > contentWidth) throw new Error('The booking address is too long for this artwork. Use a shorter booking address.');
    context.fillStyle = COLOURS.rose; context.fillText(address, x, footerY);
  }
  let blob;
  try {
    blob = await bounded(new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not create the image. Please try again.')), 'image/png')), 10000, 'Creating the image took too long. Please try again.');
  } catch { throw new Error('Could not create the image. If you added a photo, upload it again and retry.'); }
  const filenameName = name.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48).toLowerCase() || 'salon';
  return { blob, filename: `${filenameName}-${kind}-${format}.png`, width, height, mimeType: 'image/png' };
}
