import { beforeEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({result:{data:[],error:null}}));
vi.mock('../../src/config.js',()=>({supabase:{from:()=>{const q={select:()=>q,eq:()=>q,limit:async()=>fake.result};return q;}}}));
const {reviewInstagramDataRequests}=await import('../../src/services/instagram-privacy-review.js');
beforeEach(()=>{fake.result={data:[],error:null};});
it('does not alert when no deletion request needs work',async()=>{expect(await reviewInstagramDataRequests()).toEqual({pending:0});});
it('keeps pending cleanup visible as an operator action',async()=>{fake.result={data:[{id:'private-reference'}],error:null};await expect(reviewInstagramDataRequests()).rejects.toThrow('operator review');});
it('does not treat an unreadable queue as empty',async()=>{fake.result={data:null,error:{message:'failed'}};await expect(reviewInstagramDataRequests()).rejects.toThrow('could not be checked');});
