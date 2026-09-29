// Real browser canvas, fictional salon copy and generated test photo. No provider calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const index = readFileSync(join(root, 'index.html'), 'utf8');
const displayFont = index.match(/--font-display:\s*([^;]+);/)[1];
const bodyFont = index.match(/--font-body:\s*([^;]+);/)[1];
const source = readFileSync(join(root, 'src/lib/content-artwork.js'), 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', req.url === '/renderer.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/renderer.js' ? source : `<html><head><style>:root{--font-display:${displayFont};--font-body:${bodyFont};--bg:#15110F;--accent:#ffb1c8}body{font-family:var(--font-body)}</style></head><body><script type="module">import {renderContentArtwork} from '/renderer.js';window.renderContentArtwork=renderContentArtwork;</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
const output = process.env.VISUAL_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });
try {
  const context = await browser.newContext();
  const external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).hostname === '127.0.0.1') return route.continue();
    external.push(url); return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.renderContentArtwork);
  const results = await page.evaluate(async () => {
    const beforeStyle = document.documentElement.getAttribute('style');
    const fontsBefore = ['--font-display', '--font-body'].map(key => getComputedStyle(document.documentElement).getPropertyValue(key));
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    let lines = [], images = [];
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      lines.push({ text, x, y, width: this.measureText(text).width, font: this.font, size: Number(this.font.match(/([\d.]+)px/)[1]) });
      return fillText.call(this, text, x, y, ...rest);
    };
    CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
      images.push(args); return drawImage.call(this, image, ...args);
    };
    const base = { kind: 'knowledge', businessName: 'Fictional Brow Studio', title: 'A little preparation.', body: 'Arrive with clean brows. These are the salon’s supplied instructions for this fictional test.', bookingSlug: 'fictional-brow-studio' };
    async function inspect(input) {
      lines = []; images = [];
      const result = await renderContentArtwork({ ...base, ...input });
      const drawnLines = structuredClone(lines), drawnImages = structuredClone(images);
      const bytes = [...new Uint8Array(await result.blob.slice(0, 24).arrayBuffer())];
      const bitmap = await createImageBitmap(result.blob);
      const pixelCanvas = document.createElement('canvas'); pixelCanvas.width = bitmap.width; pixelCanvas.height = bitmap.height;
      const pixelContext = pixelCanvas.getContext('2d'); pixelContext.drawImage(bitmap, 0, 0);
      const corner = [...pixelContext.getImageData(10, 10, 1, 1).data];
      const scan = pixelContext.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let red = 0, blue = 0;
      for (let i = 0; i < scan.length; i += 4) { if (scan[i] > 240 && scan[i + 1] < 15 && scan[i + 2] < 15) red++; if (scan[i] < 15 && scan[i + 1] < 15 && scan[i + 2] > 240) blue++; }
      const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(result.blob); });
      bitmap.close();
      return { filename:result.filename,width:result.width,height:result.height,mimeType:result.mimeType,blobType:result.blob.type,size:result.blob.size,bytes,corner,red,blue,lines:drawnLines,images:drawnImages,dataUrl };
    }
    const feed = await inspect({ format: 'feed' });
    const story = await inspect({ kind: 'booking', format: 'story', title: 'Thursday, 12:30', body: 'Signature brows · 45 minutes\nThis is a fictional appointment for the artwork test.' });
    const long = await inspect({ title: 'Care for your brows, before your next appointment', body: 'Please follow the preparation advice your salon has supplied. '.repeat(6) + '\nIf anything is unclear, ask before your visit.' });
    const unbroken = await inspect({ title: 'A'.repeat(100), body: 'Café, colour & care. 👩🏽‍🎨\n' + 'x'.repeat(150), bookingSlug: '' });
    const photoCanvas = document.createElement('canvas'); photoCanvas.width = 240; photoCanvas.height = 120;
    const photoContext = photoCanvas.getContext('2d'); photoContext.fillStyle = '#ff0000'; photoContext.fillRect(0,0,120,120); photoContext.fillStyle = '#0000ff'; photoContext.fillRect(120,0,120,120);
    const photo = await inspect({ kind:'treatment', title:'Signature brows', body:'Original photo. Supplied treatment details.', photoUrl:photoCanvas.toDataURL('image/png') });
    const failures = [];
    for (const input of [
      { title:'Word '.repeat(60), body:'This is a long factual answer that must not be silently removed. '.repeat(35), photoUrl:photoCanvas.toDataURL('image/png') },
      { photoUrl:'javascript:alert(1)' }, { photoUrl:'https://127.0.0.1/private' }, { photoUrl:'https://user:password@example.com/photo.png' }, { photoUrl:'data:image/svg+xml,<svg/>' },
      { photoUrl:'data:image/png;base64,AAAA' }, { bookingSlug:'../another-salon?token=secret' }, { kind:'made-up' }, { format:'reel' },
    ]) {
      try { await renderContentArtwork({...base,...input}); failures.push(null); } catch (error) { failures.push(error.message); }
    }
    const fontsAfter = ['--font-display', '--font-body'].map(key => getComputedStyle(document.documentElement).getPropertyValue(key));
    const afterStyle = document.documentElement.getAttribute('style');
    CanvasRenderingContext2D.prototype.fillText = fillText;
    CanvasRenderingContext2D.prototype.drawImage = drawImage;
    return { feed,story,long,unbroken,photo,failures,fontsBefore,fontsAfter,beforeStyle,afterStyle };
  });
  for (const name of ['feed','story','long','unbroken','photo']) {
    const result = results[name];
    assert.equal(result.width,1080);
    assert.equal(result.height,name === 'story' ? 1920 : 1350);
    assert.equal(result.mimeType,'image/png'); assert.equal(result.blobType,'image/png'); assert.ok(result.size > 3000);
    assert.deepEqual(result.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);
    assert.equal(new DataView(Uint8Array.from(result.bytes).buffer).getUint32(16),result.width);
    assert.equal(new DataView(Uint8Array.from(result.bytes).buffer).getUint32(20),result.height);
    assert.deepEqual(result.corner,[251,246,241,255],'dark app mode does not change cream artwork');
    for (const line of result.lines) {
      assert.ok(line.x >= 80 && line.x + line.width <= 1000,`${name}: text exceeds horizontal boundary: ${line.text}`);
      assert.ok(line.y >= 80 && line.y + line.size * 1.5 < result.height - 60,`${name}: text exceeds vertical boundary`);
      assert.match(line.font,/Playfair Display|Plus Jakarta Sans/,'renderer uses app font families');
    }
    assert.match(result.filename,/^[a-z0-9-]+\.png$/);
    if (output) writeFileSync(join(output,result.filename.replace('.png',`-${name}.png`)),Buffer.from(result.dataUrl.split(',')[1],'base64'));
  }
  assert.ok(results.photo.red > 10000 && results.photo.blue > 10000,'both sides of the original photograph survive unchanged');
  assert.equal(results.photo.images.length,1);
  assert.equal(results.photo.images[0].length,4,'photo drawing scales the whole source without a source crop');
  assert.equal(results.long.lines.some(line => line.text.includes('If anything is unclear')),true,'the final factual sentence remains in the artwork');
  assert.ok(results.failures.every(Boolean),'invalid input must fail clearly');
  assert.match(results.failures[0],/too much text|too long/,'oversized copy is rejected rather than truncated');
  assert.match(results.failures[5],/Could not load this photo/);
  assert.deepEqual(results.fontsAfter,results.fontsBefore); assert.equal(results.afterStyle,results.beforeStyle);
  assert.deepEqual(external,[],'artwork does not load dependencies or send data externally');
  assert.deepEqual(errors,[]);
  console.log('PASS content artwork: real PNG feed/story dimensions, app fonts and cream palette, long/unbroken text within bounds, full unchanged photo, honest errors and no outbound requests');
  await context.close();
} finally { await browser.close(); server.close(); }
