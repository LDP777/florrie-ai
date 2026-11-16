import { describe,it,expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { salonEmailConfig,mailboxLocalPart,salonFrom,verifySalonWebhook,normaliseSalonEmail,resendRequest } from '../../src/lib/salon-email.js';
describe('salon email boundary',()=>{
 const owner='11111111-1111-4111-8111-111111111111';
 const env={SALON_EMAIL_ENABLED:'true',SALON_EMAIL_DOMAIN_VERIFIED:'true',SALON_EMAIL_DOMAIN:'inbox.florrie.ai',RESEND_API_KEY:'test',SALON_EMAIL_WEBHOOK_SECRET:'test',SALON_EMAIL_SALONS:owner};
 it('requires verified subdomain, receiving secret and an explicit rollout',()=>{
  expect(salonEmailConfig(owner,env)?.domain).toBe('inbox.florrie.ai');
  for(const patch of [{SALON_EMAIL_DOMAIN_VERIFIED:'false'},{SALON_EMAIL_WEBHOOK_SECRET:''},{SALON_EMAIL_DOMAIN:'florrie.ai'},{SALON_EMAIL_DOMAIN:'evil.test'},{SALON_EMAIL_SALONS:''}]) expect(salonEmailConfig(owner,{...env,...patch})).toBeNull();
  expect(salonEmailConfig('another-owner',env)).toBeNull();
 });
 it('makes a stable safe address and sanitises sender names',()=>{
  expect(mailboxLocalPart({id:owner,business_name:'Éllie & Co. 🎉'})).toBe('ellie-co');
  expect(mailboxLocalPart({id:owner,booking_slug:'support'})).toBe('salon-11111111');
  expect(salonFrom('Salon\r\nBcc: "evil" <test>', 'test@inbox.florrie.ai')).toBe('"SalonBcc: evil test via Florrie" <test@inbox.florrie.ai>');
 });
 it('verifies exact bytes, timestamp and rotated signatures',()=>{
  const raw=Buffer.from('{"type":"email.received"}'),secret='whsec_'+Buffer.alloc(32,8).toString('base64'),stamp='1794859200';
  const signature=createHmac('sha256',Buffer.alloc(32,8)).update(`event1.${stamp}.`).update(raw).digest('base64');
  const headers={'svix-id':'event1','svix-timestamp':stamp,'svix-signature':`v2,ignored v1,${signature}`};
  expect(verifySalonWebhook(raw,headers,secret,Number(stamp)*1000)).toBe(true);
  expect(verifySalonWebhook(Buffer.from(raw+' '),headers,secret,Number(stamp)*1000)).toBe(false);
  expect(verifySalonWebhook(raw,headers,secret,(Number(stamp)+301)*1000)).toBe(false);
  expect(verifySalonWebhook(raw,{...headers,'svix-id':'changed'},secret,Number(stamp)*1000)).toBe(false);
 });
 const mail={from:'Client <client@example.com>',to:['salon@inbox.florrie.ai'],message_id:'<message@example.com>',text:'Do you have Tuesday free?',subject:'Booking',authentication:{dmarc:'pass'}};
 it('accepts a verified enquiry with an exact thread reference',()=>expect(normaliseSalonEmail(mail,'salon@inbox.florrie.ai')).toMatchObject({from:'client@example.com',reply:'client@example.com',replyAllowed:true,internetId:'<message@example.com>'}));
 it('shows unverified or redirected mail for human review without enabling a reply',()=>{
  expect(normaliseSalonEmail({...mail,authentication:{dmarc:'fail'}},mail.to[0]).replyAllowed).toBe(false);
  expect(normaliseSalonEmail({...mail,reply_to:['elsewhere@example.com']},mail.to[0]).replyAllowed).toBe(false);
  expect(normaliseSalonEmail({...mail,message_id:'<bad>\r\nBcc:x@y.com'},mail.to[0]).replyAllowed).toBe(false);
 });
 it('does not create auto-reply loops or import newsletters',()=>{
  expect(normaliseSalonEmail({...mail,headers:{'Auto-Submitted':'auto-replied'}},mail.to[0])).toBeNull();
  expect(normaliseSalonEmail({...mail,headers:{'List-Id':'news'}},mail.to[0])).toBeNull();
  expect(normaliseSalonEmail({...mail,from:mail.to[0]},mail.to[0])).toBeNull();
 });
 it('never renders incoming HTML or downloads attachments',()=>{
  const result=normaliseSalonEmail({...mail,text:null,html:'<script>secret()</script><p>Hello</p>',attachments:[{filename:'invoice.exe'}]},mail.to[0]);
  expect(result.body).not.toContain('<script>'); expect(result.body).not.toContain('secret()'); expect(result.body).toContain('Attachment viewing is not available');
 });
 it('sends a fixed idempotency key, rejects redirects and does not retry uncertain sends',async()=>{
  let count=0;
  await expect(resendRequest('/emails',{method:'POST',body:{text:'hi'},idempotencyKey:'attempt-1',key:'test'},async(url,opts)=>{
   count++;expect(url).toBe('https://api.resend.com/emails');expect(opts.headers['Idempotency-Key']).toBe('attempt-1');expect(opts.redirect).toBe('error');throw new Error('timeout');
  })).rejects.toThrow('timeout');expect(count).toBe(1);
 });
});
