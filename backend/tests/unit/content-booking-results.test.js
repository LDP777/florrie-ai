import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),warn:vi.fn()}));
vi.mock('../../src/config.js',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('../../src/lib/logger.js',()=>({default:{warn:mocks.warn}}));
import {contentBookingUrl,recordContentBooking,validContentToken} from '../../src/services/content-booking-results.js';
beforeEach(()=>{mocks.rpc.mockReset();mocks.warn.mockReset();process.env.FRONTEND_URL='https://florrie.test';});
describe('Post-to-booking attribution',()=>{
 it('only accepts a bounded opaque token',()=>{expect(validContentToken('a'.repeat(32))).toBe(true);for(const bad of ['../x','https://evil.test','a'.repeat(200),null,{},'abc'])expect(validContentToken(bad)).toBe(false);});
 it('keeps the link on the salon’s own booking page',()=>{expect(contentBookingUrl('fictional-salon','a'.repeat(32))).toBe(`https://florrie.test/book/fictional-salon?fl_content=${'a'.repeat(32)}`);expect(contentBookingUrl('//evil.test','a'.repeat(32))).toBeNull();});
 it('does nothing for ordinary bookings without a content link',async()=>{expect(await recordContentBooking('owner','appointment',null)).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('binds the source to this owner and appointment and bounds the request',async()=>{const abortSignal=vi.fn().mockResolvedValue({data:true,error:null});mocks.rpc.mockReturnValue({abortSignal});expect(await recordContentBooking('owner','appointment','a'.repeat(32))).toBe(true);expect(mocks.rpc).toHaveBeenCalledWith('record_content_booking',{p_owner:'owner',p_appointment:'appointment',p_token:'a'.repeat(32)});expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);});
 it('a missing migration or storage failure never rejects a booking',async()=>{mocks.rpc.mockReturnValue({abortSignal:vi.fn().mockResolvedValue({data:null,error:{code:'missing'}})});expect(await recordContentBooking('owner','appointment','a'.repeat(32))).toBe(false);expect(mocks.warn).toHaveBeenCalledTimes(1);});
});
