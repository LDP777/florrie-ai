import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  usage: null,
  rpc: vi.fn(),
  writes: [],
  salon: { subscription_plan: 'florrie', whatsapp_phone_id: 'phone-fixture', whatsapp_connected: true },
}));

vi.mock('../../src/config.js', () => ({ supabase: {
  rpc: (...args) => state.rpc(...args),
  from(table) {
    let update;
    const settle = () => {
      if (table === 'beauticians') return { data: state.salon, error: null };
      if (table !== 'message_usage') throw new Error(`Unexpected table: ${table}`);
      if (update) {
        state.writes.push(structuredClone(update));
        Object.assign(state.usage, update);
      }
      return { data: structuredClone(state.usage), error: null };
    };
    const query = {
      select() { return query; },
      eq() { return query; },
      update(value) { update = value; return query; },
      async single() { return settle(); },
      then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
    };
    return query;
  },
} }));
vi.mock('../../src/lib/logger.js', () => ({ default: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} }));

import { checkMessageLimit } from '../../src/lib/tiers.js';
import { checkWhatsAppQuota, trackSmsInMonthlyQuota, trackWhatsAppMessage } from '../../src/services/whatsapp-metering.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.usage = {
    id: 'usage-fixture', beautician_id: 'salon-fixture', free_limit: 120,
    sms_sent: 20, whatsapp_sent: 100,
    overage_sms_count: 0, overage_wa_count: 0,
    overage_sms_pence: 0, overage_wa_pence: 0, overage_total_pence: 0,
  };
  state.writes = [];
  state.salon = { subscription_plan: 'florrie', whatsapp_phone_id: 'phone-fixture', whatsapp_connected: true };
  state.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'RPC unavailable' } });
});

describe('advertised monthly overage rates', () => {
  it.each([
    ['whatsapp', 5, trackWhatsAppMessage],
    ['sms', 6, trackSmsInMonthlyQuota],
  ])('passes the %s rate to the atomic meter without a second increment', async (channel, rate, record) => {
    state.rpc.mockResolvedValue({ data: [state.usage], error: null });
    await record('salon-fixture');
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('increment_message_usage', {
      p_beautician_id: 'salon-fixture', p_month: expect.stringMatching(/^\d{4}-\d{2}-01$/),
      p_free_limit: 120, p_channel: channel, p_overage_pence: rate,
    });
    expect(state.writes).toEqual([]);
  });

  it.each([
    ['whatsapp', trackWhatsAppMessage, trackSmsInMonthlyQuota, { whatsapp_sent: 100, sms_sent: 19 }, 6],
    ['sms', trackSmsInMonthlyQuota, trackWhatsAppMessage, { whatsapp_sent: 100, sms_sent: 19 }, 5],
  ])('keeps the 120th %s message free and charges the next channel correctly in fallback', async (_, first, next, counts, price) => {
    Object.assign(state.usage, counts);
    await first('salon-fixture');
    expect(state.usage.overage_total_pence).toBe(0);
    expect(state.usage.sms_sent + state.usage.whatsapp_sent).toBe(120);
    await next('salon-fixture');
    expect(state.usage.overage_total_pence).toBe(price);
    expect(state.usage.overage_sms_count + state.usage.overage_wa_count).toBe(1);
  });

  it('adds 5p and 6p with separate channel counters without repricing existing accrual', async () => {
    Object.assign(state.usage, {
      sms_sent: 30, whatsapp_sent: 100,
      overage_sms_count: 4, overage_wa_count: 6,
      overage_sms_pence: 28, overage_wa_pence: 42, overage_total_pence: 70,
    });
    await trackWhatsAppMessage('salon-fixture');
    await trackSmsInMonthlyQuota('salon-fixture');
    expect(state.usage).toMatchObject({
      sms_sent: 31, whatsapp_sent: 101,
      overage_sms_count: 5, overage_wa_count: 7,
      overage_sms_pence: 34, overage_wa_pence: 47, overage_total_pence: 81,
    });
    expect(state.writes).toHaveLength(2);
    expect(state.writes.every(write => !('billed' in write) && !('stripe_invoice_id' in write))).toBe(true);
  });

  it('reports 5p WhatsApp overage while allowing sends at the allowance', async () => {
    expect(await checkWhatsAppQuota('salon-fixture')).toMatchObject({
      allowed: true, isOverage: true, used: 120, limit: 120, remaining: 0, overageRate: 5,
    });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it('keeps disconnected-account protection and included-message eligibility', async () => {
    state.usage.sms_sent = 19;
    expect(await checkWhatsAppQuota('salon-fixture')).toMatchObject({ allowed: true, isOverage: false, remaining: 1 });
    state.salon.whatsapp_connected = false;
    expect(await checkWhatsAppQuota('salon-fixture')).toEqual({ allowed: false, reason: 'no_whatsapp_number' });
  });

  it('reports both rates through the tier helper without changing team allowances', () => {
    expect(checkMessageLimit('florrie_team', 240, 2)).toMatchObject({
      allowed: false, limit: 240, remaining: 0, overage_rates_pence: { whatsapp: 5, sms: 6 },
    });
  });
});
