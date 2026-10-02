import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const note = 'Please give 48 hours notice.\nLate cancellations and no-shows are charged at the full treatment price.';
const initialPolicy = { cancellation_notice_hours: 48, late_cancel_charge_percent: 0, no_show_charge_percent: 100,
  cancellation_message: note, reschedule_once: true, min_booking_hours: 2, max_advance_days: 45, untouched_rule: 'preserved' };
const editorBuild = await build({
  stdin: { resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx', contents: `
    import React, {useState} from 'react';import {createRoot} from 'react-dom/client';import Editor from './src/components/BookingPolicyEditor.jsx';
    window.__draftSaves=[];window.__saveMode='success';
    function Demo(){
      const [owner,setOwner]=useState({id:'fictional-a',booking_policy:${JSON.stringify(initialPolicy)}}),[error,setError]=useState('');
      window.__refreshPolicy=patch=>setOwner(previous=>({...previous,booking_policy:{...previous.booking_policy,...patch}}));
      window.__switchOwner=()=>{setError('');setOwner({id:'fictional-b',booking_policy:{cancellation_notice_hours:24,late_cancel_charge_percent:70,no_show_charge_percent:80,cancellation_message:'Second owner policy'}})};
      async function save(policy){
        const ownerId=owner.id;window.__draftSaves.push({ownerId,policy});
        const outcome=window.__saveMode==='hold'?await new Promise(resolve=>{window.__finishSave=resolve}):window.__saveMode;
        if(outcome==='failure'){setError('Synthetic save failure. Your draft has been kept.');return false}
        if(outcome==='throw')throw new Error('Synthetic failure');
        if(outcome!=='success-stale')setOwner(previous=>previous.id===ownerId?{...previous,booking_policy:policy}:previous);
        return true;
      }
      return <Editor beautician={owner} onSave={save} saveError={error}/>;
    }createRoot(document.getElementById('root')).render(<Demo/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
});
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  if (request.url === '/policy-draft-fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(editorBuild.outputFiles[0].text); return; }
  if (request.url === '/policy-draft-fixture') { response.setHeader('content-type', 'text/html'); response.end('<div id="root"></div><script src="/policy-draft-fixture.js"></script>'); return; }
  let file = join(dist, (request.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { response.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); response.end(readFileSync(file)); }
  catch { response.statusCode = 404; response.end(); }
}).listen(0);
const browser = await launch();

async function fixture(policy) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(policy => {
    const base = window.fetch;
    window.__policyWrites = [];
    window.__profile = { id: 'b1', auth_id: 'b1', email: 'owner@fictional-salon.test', first_name: 'Mara',
      last_name: 'Demo', business_name: 'Fictional Salon', timezone: 'Europe/London',
      onboarding_completed_at: '2026-06-01T10:00:00Z', trial_ends_at: '2099-01-01T00:00:00Z', plan: 'pro',
      stripe_onboarding_complete: true, payment_settings: { require_deposit: false }, booking_policy: policy };
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(options.method || input?.method || 'GET').toUpperCase();
      if (url.includes('/rest/v1/beauticians')) {
        if (method === 'PATCH') {
          const body = JSON.parse(options.body);
          window.__policyWrites.push(body);
          Object.assign(window.__profile, body);
          return json(window.__profile);
        }
        return json(window.__profile);
      }
      return base(input, options);
    };
  }, policy);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/settings?section=policy`);
  await page.getByRole('spinbutton', { name: /late.cancel/i }).waitFor();
  return { context, page, pageErrors };
}

try {
  const { context, page, pageErrors } = await fixture(initialPolicy);
  const lateFee = page.getByRole('spinbutton', { name: /late.cancel/i });
  const noShowFee = page.getByRole('spinbutton', { name: 'No-show charge', exact: true });
  const noteField = page.getByRole('textbox', { name: /cancellation note/i });
  const saveButton = page.getByRole('button', { name: 'Save policy', exact: true });
  const saveRemainsReachable = async field => {
    await field.scrollIntoViewIfNeeded(); await field.focus();
    const bounds = await saveButton.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height < 734, 'Sticky Save must be visible above bottom navigation');
    assert.equal(await saveButton.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top === button || button.contains(top);
    }), true, 'Other app chrome must not cover Save');
  };
  assert.equal(await lateFee.inputValue(), '0');
  assert.equal(await noShowFee.inputValue(), '100');
  assert.equal(await page.getByRole('spinbutton', { name: 'Custom booking window', exact: true }).inputValue(), '45');
  assert.equal(await noteField.inputValue(), note);
  assert.equal(await page.getByText('No charge applies for late cancellations.', { exact: false }).count(), 0);
  assert.equal(await page.getByText('You always confirm each charge yourself before any money is taken.', { exact: false }).count(), 0);
  const notePreview = page.locator('p').filter({ hasText: 'Late cancellations and no-shows are charged at the full treatment price.' });
  await notePreview.waitFor();
  assert.ok((await notePreview.textContent()).includes(note));
  assert.ok(['pre-wrap', 'pre-line', 'break-spaces'].includes(await notePreview.evaluate(element => getComputedStyle(element).whiteSpace)), 'Preview must preserve the salon’s line breaks');
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [], 'Opening Settings must not change the fee or policy');

  await noteField.focus();
  const review = page.getByRole('button', { name: /review.*(?:late.cancel|fee)/i });
  await review.click();
  assert.equal(await lateFee.evaluate(element => document.activeElement === element), true, 'Review must focus the real fee control');
  assert.equal(await lateFee.inputValue(), '0');
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [], 'Reviewing or leaving an unchanged note must not save');
  const bounds = await lateFee.boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y < 844, 'Reviewed fee control should be in the mobile viewport');
  await saveRemainsReachable(lateFee);
  await saveRemainsReachable(noteField);

  if (process.env.FLORRIE_VISUAL_OUT) {
    mkdirSync(process.env.FLORRIE_VISUAL_OUT, { recursive: true });
    await noteField.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(process.env.FLORRIE_VISUAL_OUT, 'settings-policy-note-mobile.png') });
    await review.click();
  }

  // All edits remain local until the owner explicitly saves the whole policy.
  await lateFee.fill('10');
  const editedNote = `${note}\nPlease contact the salon if you need help.`;
  await noteField.fill(editedNote);
  await review.click();
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), []);
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await page.getByText('Policy saved.', { exact: true }).waitFor();
  const savedPolicy = { ...initialPolicy, late_cancel_charge_percent: 10, cancellation_message: editedNote,
    payment_buffer_minutes: 10, payment_buffer_enabled: false, require_deposit_on_late_reschedule: false, reschedule_between_only: false };
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [{
    booking_policy: savedPolicy,
  }]);
  assert.equal(await page.getByRole('button', { name: 'Save policy', exact: true }).isDisabled(), true);
  assert.equal(await lateFee.inputValue(), '10');
  assert.equal(await noShowFee.inputValue(), '100');

  await page.getByRole('spinbutton', { name: 'Cancellation notice', exact: true }).fill('0');
  assert.equal(await noShowFee.isVisible(), true, 'No-show fee must remain independently editable with no cancellation notice');
  await noShowFee.fill('80');
  await page.getByRole('button', { name: 'Reset edits', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: 'Cancellation notice', exact: true }).inputValue(), '48');
  assert.equal(await noShowFee.inputValue(), '100');
  assert.equal(await page.evaluate(() => window.__policyWrites.length), 1);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('✓ Mobile policy: every edit stays local until Save; the complete save preserves unrelated rules; Reset and zero-notice no-show editing are independent');

  const missingPolicy = { ...initialPolicy };
  delete missingPolicy.late_cancel_charge_percent;
  const fallback = await fixture(missingPolicy);
  assert.equal(await fallback.page.getByRole('spinbutton', { name: /late.cancel/i }).inputValue(), '0', 'An unset fee must match the backend’s zero default');
  assert.deepEqual(await fallback.page.evaluate(() => window.__policyWrites), []);
  assert.equal(await fallback.page.getByText('No charge applies for late cancellations.', { exact: false }).count(), 0);
  assert.deepEqual(fallback.pageErrors, []);
  await fallback.context.close();
  console.log('✓ Unset late-cancellation fee displays zero without silently saving a new policy');

  // The actual extracted component, with controlled prop refresh and save races.
  const draftContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const draft = await draftContext.newPage(); draft.setDefaultTimeout(15000);
  const draftErrors = []; draft.on('pageerror', error => draftErrors.push(error.message));
  await draft.goto(`http://127.0.0.1:${server.address().port}/policy-draft-fixture`);
  const draftNote = draft.getByRole('textbox', { name: /cancellation note/i });
  const draftLate = draft.getByRole('spinbutton', { name: /late.cancel/i });
  const draftSave = draft.getByRole('button', { name: 'Save policy', exact: true });
  await draftNote.fill('Unsaved wording\nSecond line');
  await draft.evaluate(() => window.__refreshPolicy({ late_cancel_charge_percent: 30, untouched_rule: 'refreshed', newly_added_rule: 'also preserved' }));
  await draft.waitForFunction(() => document.getElementById('late-cancellation-fee').value === '30');
  assert.equal(await draftNote.inputValue(), 'Unsaved wording\nSecond line');
  assert.equal(await draftLate.inputValue(), '30');
  assert.equal(await draft.evaluate(() => window.__draftSaves.length), 0);
  await draft.evaluate(() => { window.__saveMode = 'failure'; });
  await draftSave.click();
  await draft.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).waitFor();
  assert.equal(await draftNote.inputValue(), 'Unsaved wording\nSecond line');
  assert.equal(await draftSave.isEnabled(), true);
  assert.deepEqual(await draft.evaluate(() => ({ known: window.__draftSaves[0].policy.late_cancel_charge_percent,
    unknown: window.__draftSaves[0].policy.untouched_rule, added: window.__draftSaves[0].policy.newly_added_rule })), {
    known: 30, unknown: 'refreshed', added: 'also preserved',
  });
  await draft.evaluate(() => { window.__saveMode = 'success-stale'; });
  await draftSave.click();
  await draft.getByText('Policy saved.', { exact: true }).waitFor();
  assert.equal(await draftNote.inputValue(), 'Unsaved wording\nSecond line', 'A successful save must not snap back to stale props');
  assert.equal(await draftSave.isDisabled(), true);

  await draftLate.fill('40');
  await draft.evaluate(() => { window.__saveMode = 'hold'; });
  await draftSave.click();
  assert.equal(await draftLate.isDisabled(), true);
  assert.equal(await draftNote.isDisabled(), true);
  assert.equal(await draftSave.isDisabled(), true);
  await draft.evaluate(() => window.__switchOwner());
  await draft.waitForFunction(() => document.getElementById('cancellation-note').value === 'Second owner policy');
  assert.equal(await draftLate.inputValue(), '70');
  await draft.evaluate(() => window.__finishSave('success'));
  await draft.waitForFunction(() => document.getElementById('late-cancellation-fee').value === '70');
  assert.equal(await draftNote.inputValue(), 'Second owner policy');
  assert.equal(await draftSave.isDisabled(), true);
  assert.equal(await draft.getByText('Policy saved.', { exact: true }).count(), 0, 'Old-owner save completion must not update the new owner’s state');
  assert.equal(await draft.evaluate(() => window.__draftSaves.length), 3);
  assert.deepEqual(draftErrors, []);
  await draftContext.close();
  console.log('✓ Draft state: refresh preserves edits; failed save keeps draft; successful stale-prop save stays visible; pending controls lock; old-owner response is ignored');
} finally {
  await browser.close();
  server.close();
}
