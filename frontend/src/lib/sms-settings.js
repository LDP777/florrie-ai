// Setup changes are never retried automatically: a lost response may follow a
// successful save or a sent SMS. Reads use authenticated-json's safe GET retry.
export async function writeSmsSettings({ auth, url, body, method, request = fetch, timeoutMs = 20_000 }) {
  const controller = new AbortController();
  let timer;
  let dispatched = false;
  try {
    return await Promise.race([
      (async () => {
        const session = await auth.getSession();
        if (controller.signal.aborted) throw new Error('Request expired');
        if (session.error || !session.data?.session?.access_token) {
          throw new Error('Your session is unavailable. Try again or sign in again.');
        }
        dispatched = true;
        const response = await request(url, {
          method, signal: controller.signal,
          headers: { Authorization: `Bearer ${session.data.session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        let data;
        try { data = await response.json(); } catch { /* Treat an unreadable success as unconfirmed. */ }
        if (!response.ok) {
          const error = new Error(response.status === 401
            ? 'Your session has expired. Sign in again, then try again.'
            : (data?.error || 'Could not complete this request. Please try again.'));
          // A server error can happen after a provider accepted the SMS or
          // after the save committed. Only a client rejection is definitive.
          error.confirmedFailure = response.status >= 400 && response.status < 500;
          throw error;
        }
        if (data?.success !== true) throw new Error('No confirmation received');
        return data;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (dispatched && !error.confirmedFailure) {
      throw new Error(method === 'POST'
        ? 'We couldn’t confirm whether the test was sent. Check the phone before sending another.'
        : 'We couldn’t confirm the save. Your edits are still here; try saving again when connected.');
    }
    throw error;
  } finally { clearTimeout(timer); }
}

export function monthlyMessageUsage(data) {
  const usage = data?.usage;
  const fields = ['sms_sent', 'whatsapp_sent', 'total_sent', 'free_limit', 'remaining', 'overage_total_pence'];
  if (!usage || fields.some(key => !Number.isFinite(usage[key]) || usage[key] < 0)
    || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(usage.month || '')) {
    throw new Error('Message usage is unavailable. Please try again.');
  }
  return usage;
}

export function smsSettingsChanges(config, form) {
  const inbound = form.inbound.replace(/\s/g, '');
  const next = {
    sms_originator: form.name.trim() || 'Florrie',
    sms_inbound_number: (/^\d{7,15}$/.test(inbound) ? `+${inbound}` : inbound) || null,
    sms_channel_id: form.channel.trim() || null,
  };
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== (config[key] || null)));
}
