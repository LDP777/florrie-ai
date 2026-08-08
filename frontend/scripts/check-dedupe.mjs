/**
 * The request deduper must hand every caller a readable body.
 *
 * A Response body can be consumed exactly once. Sharing one Response between
 * two callers means the second gets "body stream already read" — which would
 * turn a duplicate-request optimisation into a broken screen. The clone() in
 * dedupe-fetch.js is the whole mechanism, so it gets a test.
 *
 *   node scripts/check-dedupe.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, unlinkSync } from 'node:fs';

let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ rows: [{ id: 'a' }], hit: hits }));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const out = await build({
  entryPoints: [new URL('../src/lib/dedupe-fetch.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const tmp = new URL('../.dedupe-test.mjs', import.meta.url).pathname;
writeFileSync(tmp, out.outputFiles[0].text);
const { dedupeFetch } = await import(pathToFileURL(tmp).href);
unlinkSync(tmp);

const fail = [];
const check = (label, ok, detail = '') => { if (!ok) fail.push(label + (detail ? ` — ${detail}` : '')); };

// 1. Two concurrent identical GETs, one round trip, both bodies readable.
hits = 0;
const [a, b] = await Promise.all([
  dedupeFetch(`${base}/api/activity/feed?limit=50`, { headers: { Authorization: 'Bearer t' } }),
  dedupeFetch(`${base}/api/activity/feed?limit=50`, { headers: { Authorization: 'Bearer t' } }),
]);
check('one round trip for two identical callers', hits === 1, `made ${hits}`);
let ja, jb;
try { ja = await a.json(); } catch (e) { check('first caller can read the body', false, e.message); }
try { jb = await b.json(); } catch (e) { check('second caller can read the body', false, e.message); }
check('both callers get the same payload', JSON.stringify(ja) === JSON.stringify(jb));

// 2. Nothing is retained: the next call goes to the network.
hits = 0;
await (await dedupeFetch(`${base}/x`, {})).json();
await (await dedupeFetch(`${base}/x`, {})).json();
check('it is not a cache — sequential calls both hit the network', hits === 2, `made ${hits}`);

// 3. Different tokens are different requests. Coalescing across users would
//    serve one person's data to another, which is the one truly bad outcome.
hits = 0;
await Promise.all([
  dedupeFetch(`${base}/y`, { headers: { Authorization: 'Bearer one' } }),
  dedupeFetch(`${base}/y`, { headers: { Authorization: 'Bearer two' } }),
]);
check('different auth is never coalesced', hits === 2, `made ${hits}`);

// 4. POST is passed straight through. Coalescing a write would drop somebody's.
hits = 0;
await Promise.all([
  dedupeFetch(`${base}/z`, { method: 'POST', body: '{}' }),
  dedupeFetch(`${base}/z`, { method: 'POST', body: '{}' }),
]);
check('POSTs are never coalesced', hits === 2, `made ${hits}`);

server.close();
if (fail.length) {
  console.error(`✗ dedupe: ${fail.length} failure(s)\n  ` + fail.join('\n  '));
  process.exit(1);
}
console.log('✓ dedupe: identical in-flight GETs share one round trip, every caller gets a readable body, and nothing is cached, cross-user or written');
process.exit(0);
