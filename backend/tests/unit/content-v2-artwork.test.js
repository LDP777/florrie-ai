import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { contentImagePath, renderContentV2Artwork, renderContentV2Image } from '../../src/services/content-v2/artwork.js';
import sharp from 'sharp';

const owner = 'fictional-salon', base = 'https://fictional.supabase.co';
const sourceUrl = `${base}/storage/v1/object/public/content-images/${owner}/gallery/source.png`;
const layout = (kind, values = {}) => ({ media: { type: 'layout', layout: { kind, title: 'Christmas lashes', headline: '£10 off lash lift & tint',
  lines: ['Appointments 1 to 24 December', '£40 instead of £50', 'Book by 20 December', 'Code FESTIVE10', 'One per client.'], ...values } } });
const profile = { business_name: 'Cedar Beauty' };
async function stripedPhoto() {
  return sharp({ create: { width: 400, height: 200, channels: 3, background: '#008000' } }).composite([
    { input: { create: { width: 20, height: 200, channels: 3, background: '#ff0000' } }, top: 0, left: 0 },
    { input: { create: { width: 20, height: 200, channels: 3, background: '#0000ff' } }, top: 0, left: 380 },
  ]).png().toBuffer();
}
async function pixels(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
}
function storage() {
  const files = new Map();
  const bucket = {
    download: vi.fn(async key => ({ data: files.has(key) ? new Blob([files.get(key)]) : null, error: files.has(key) ? null : { message: 'Missing fictional photo' } })),
    upload: vi.fn(async (key, buffer) => {
      if (files.has(key)) return { error: { statusCode: '409', error: 'Duplicate' } };
      files.set(key, buffer); return { data: { path: key }, error: null };
    }),
    getPublicUrl: vi.fn(key => ({ data: { publicUrl: `${base}/storage/v1/object/public/content-images/${key}` } })),
  };
  return { files, bucket, db: { storage: { from: vi.fn(name => { expect(name).toBe('content-images'); return bucket; }) } } };
}

describe('server Content artwork', () => {
  it('rasterises distinct brand font shapes instead of falling back to the same system sans', async () => {
    const text = 'Brow lamination 123';
    const serif = await sharp({ text: { text, font: 'Playfair Display 78', rgba: true } }).png().toBuffer();
    const sans = await sharp({ text: { text, font: 'Plus Jakarta Sans 78', rgba: true } }).png().toBuffer();
    expect(serif.equals(sans)).toBe(false);
    expect((await sharp(serif).metadata()).width).not.toBe((await sharp(sans).metadata()).width);
  });
  it.each(['offer', 'availability', 'quote', 'course'])('renders %s with the licensed fonts, complete supplied words and real JPEG pixels', async kind => {
    const textInputs = [];
    const sharpImpl = (...args) => { if (args[0]?.text) textInputs.push(args[0].text); return sharp(...args); };
    const post = layout(kind, kind === 'quote' ? { lines: ['Lash lift and tint'] } : {});
    const buffer = await renderContentV2Image(post, profile, { sharpImpl });
    const metadata = await sharp(buffer).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 1080, height: 1350, channels: 3 });
    const pixel = await pixels(buffer);
    pixel(10, 10).forEach((value, index) => expect(Math.abs(value - [251, 246, 241][index])).toBeLessThanOrEqual(2));
    expect(pixel(90, 141)[0]).toBeGreaterThan(180);
    expect(pixel(90, 141)[1]).toBeLessThan(200);
    expect(textInputs.some(text => text.fontfile.endsWith('/PlayfairDisplay.ttf'))).toBe(true);
    expect(textInputs.some(text => text.fontfile.endsWith('/PlusJakartaSans.ttf'))).toBe(true);
    expect(textInputs.some(text => text.text.includes('£10 off lash lift &amp; tint'))).toBe(true);
    for (const line of post.media.layout.lines) expect(textInputs.some(text => text.text.includes(line))).toBe(true);
    const { channels } = await sharp(buffer).extract({ left: 72, top: 352, width: 936, height: 310 }).stats();
    expect(channels[0].min).toBeLessThan(70);
  }, 40000);
  it('normalises a PNG to JPEG without cropping either edge of the photo', async () => {
    const buffer = await renderContentV2Image({ media: { type: 'photo', image_url: sourceUrl } }, profile, { loadImage: async () => stripedPhoto() });
    expect(await sharp(buffer).metadata()).toMatchObject({ format: 'jpeg', width: 1080, height: 1350 });
    const pixel = await pixels(buffer);
    expect(pixel(5, 650)[0]).toBeGreaterThan(230); expect(pixel(5, 650)[2]).toBeLessThan(20);
    expect(pixel(1075, 650)[2]).toBeGreaterThan(230); expect(pixel(1075, 650)[0]).toBeLessThan(20);
    expect(pixel(540, 200)[0]).toBeGreaterThan(240);
  });
  it('refuses oversized words instead of shrinking factual terms below readable size', async () => {
    await expect(renderContentV2Image(layout('offer', { lines: ['One per client. '.repeat(200)] }), profile)).rejects.toThrow('too much text');
    await expect(renderContentV2Image(layout('quote', { headline: 'A long review. '.repeat(300) }), profile)).rejects.toThrow('too much text');
  });
  it('stacks both complete before and after photos with distinct cream labels', async () => {
    const loadImage = vi.fn(async () => stripedPhoto());
    const buffer = await renderContentV2Image(layout('before_after', { title: 'Lash lift', headline: 'Lash lift', before_url: sourceUrl, after_url: sourceUrl }), profile, { loadImage });
    expect(loadImage).toHaveBeenCalledTimes(2);
    const pixel = await pixels(buffer);
    for (const y of [530, 970]) {
      expect(pixel(130, y)[0]).toBeGreaterThan(230);
      expect(pixel(950, y)[2]).toBeGreaterThan(230);
    }
    expect(pixel(100, 368)[0]).toBeGreaterThan(240);
  });
  it('uses an immutable content hash URL, reuses existing identical bytes and changes the URL after facts change', async () => {
    const { db, bucket } = storage();
    const options = { db, supabaseUrl: base };
    const first = await renderContentV2Artwork(owner, layout('offer'), profile, options);
    expect(first).toMatch(/\/fictional-salon\/content-v2\/artwork-[a-f0-9]{64}\.jpg$/);
    expect(await renderContentV2Artwork(owner, layout('offer'), profile, options)).toBe(first);
    expect(bucket.download).toHaveBeenCalledTimes(1);
    const changed = await renderContentV2Artwork(owner, layout('offer', { lines: ['£45 instead of £55'] }), profile, options);
    expect(changed).not.toBe(first);
    expect(bucket.upload.mock.calls[0][2]).toEqual({ contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  });
  it('downloads a same-owner source using storage, never an arbitrary URL fetch', async () => {
    const { db, bucket, files } = storage();
    files.set(`${owner}/gallery/source.png`, await stripedPhoto());
    const url = await renderContentV2Artwork(owner, { media: { type: 'photo', image_url: sourceUrl } }, profile, { db, supabaseUrl: base });
    expect(bucket.download).toHaveBeenCalledWith(`${owner}/gallery/source.png`);
    expect(url).toContain('/content-v2/artwork-');
  });
  it.each([
    'https://other.example/storage/v1/object/public/content-images/fictional-salon/photo.jpg',
    `${base}/storage/v1/object/public/content-images/another-salon/photo.jpg`,
    `${base}/storage/v1/object/sign/content-images/fictional-salon/photo.jpg`,
    `${base}/storage/v1/object/public/content-images/fictional-salon/%2e%2e/another-salon/photo.jpg`,
    `${base}/storage/v1/object/public/content-images/fictional-salon/%2fother.jpg`,
    `https://username@fictional.supabase.co/storage/v1/object/public/content-images/fictional-salon/photo.jpg`,
  ])('rejects unsafe source %s before storage reads', async image_url => {
    const { db, bucket } = storage();
    await expect(renderContentV2Artwork(owner, { media: { type: 'photo', image_url } }, profile, { db, supabaseUrl: base })).rejects.toThrow('Content library');
    expect(bucket.download).not.toHaveBeenCalled(); expect(bucket.upload).not.toHaveBeenCalled();
  });
  it('reports missing downloads and upload failures instead of returning a broken URL', async () => {
    const { db, bucket } = storage();
    await expect(renderContentV2Artwork(owner, { media: { type: 'photo', image_url: sourceUrl } }, profile, { db, supabaseUrl: base })).rejects.toThrow('downloaded');
    bucket.upload.mockResolvedValueOnce({ error: { statusCode: '403', message: 'Storage refused fictional write' } });
    await expect(renderContentV2Artwork(owner, layout('offer'), profile, { db, supabaseUrl: base })).rejects.toThrow('could not be saved');
    expect(bucket.getPublicUrl).not.toHaveBeenCalled();
  });
  it('rejects a conflicting existing object and unsafe image formats', async () => {
    const { db, bucket } = storage();
    bucket.upload.mockResolvedValueOnce({ error: { statusCode: '409' } });
    bucket.download.mockResolvedValueOnce({ data: new Blob(['different bytes']), error: null });
    await expect(renderContentV2Artwork(owner, layout('offer'), profile, { db, supabaseUrl: base })).rejects.toThrow('could not be verified');
    const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    await expect(renderContentV2Image({ media: { type: 'photo', image_url: sourceUrl } }, profile, { loadImage: async () => input })).rejects.toThrow('format');
  });
  it('rejects an invalid owner before any storage operation', async () => {
    const { db } = storage();
    await expect(renderContentV2Artwork('../another-salon', layout('offer'), profile, { db, supabaseUrl: base })).rejects.toThrow('saved salon');
    expect(db.storage.from).not.toHaveBeenCalled();
    expect(() => contentImagePath(owner, sourceUrl, 'invalid-base')).toThrow('Content library');
  });
});
