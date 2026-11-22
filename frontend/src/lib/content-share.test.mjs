import test from 'node:test';
import assert from 'node:assert/strict';
import { contentImageBlob } from './content-share.js';

test('downloads image bytes with no cookies and retains the image type', async () => {
  let options;
  const blob = await contentImageBlob('https://photos.example.test/post.jpg', { fetcher: async (_url, opts) => { options=opts; return new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg'}}); } });
  assert.equal(blob.type,'image/jpeg'); assert.equal(blob.size,3); assert.equal(options.credentials,'omit'); assert.equal(options.referrerPolicy,'no-referrer');
});
test('refuses unsafe URLs before making a request', async () => {
  for(const url of ['file:///etc/passwd','http://photos.example.test/image.jpg','https://name:password@example.test/image.jpg','javascript:alert(1)']) {
    await assert.rejects(contentImageBlob(url,{fetcher:()=>{throw new Error('must not fetch');}}),/cannot be shared/);
  }
});
test('reports provider failures, wrong formats and empty images', async () => {
  for(const response of [new Response('',{status:403}),new Response('html',{headers:{'content-type':'text/html'}}),new Response('',{headers:{'content-type':'image/jpeg'}})]) {
    await assert.rejects(contentImageBlob('https://photos.example.test/image.jpg',{fetcher:async()=>response}),/Could not download|format cannot|image is empty/);
  }
});
test('rejects oversized responses before buffering',async()=>{
  await assert.rejects(contentImageBlob('https://photos.example.test/image.jpg',{fetcher:async()=>new Response('image',{headers:{'content-type':'image/jpeg','content-length':String(21*1024*1024)}})}),/too large/);
});
