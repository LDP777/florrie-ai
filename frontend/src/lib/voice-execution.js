const UNCERTAIN_RESULT = 'Florrie could not confirm the result. Check the result before repeating this action.';
const SIGN_IN_REQUIRED = 'Sign in again to use Florrie. This action has not been sent.';
const CANCELLED_ACTION = 'Your conversation changed. This action has not been sent.';

function executionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Execute one confirmed proposal once, including authentication in the deadline. */
export async function executeVoiceProposal({
  auth, url, tool, input, canExecute = () => true, request = fetch, timeoutMs = 30000,
}) {
  const controller = new AbortController();
  let timer;
  let sent = false;
  const maySend = () => {
    try { return canExecute() === true; } catch { return false; }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(executionError(sent ? UNCERTAIN_RESULT : 'Florrie took too long to prepare this action. It has not been sent.',
        sent ? 'VOICE_RESULT_UNCERTAIN' : 'VOICE_NOT_SENT'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([deadline, (async () => {
      if (!maySend()) throw executionError(CANCELLED_ACTION, 'VOICE_ACTION_CANCELLED');
      if (typeof auth?.getSession !== 'function') throw executionError(SIGN_IN_REQUIRED, 'VOICE_AUTH_REQUIRED');
      let session;
      try { session = await auth.getSession(); }
      catch { throw executionError(SIGN_IN_REQUIRED, 'VOICE_AUTH_REQUIRED'); }
      // A timed-out or superseded confirmation must not send when auth resolves later.
      if (controller.signal.aborted) throw executionError('This action timed out before it was sent.', 'VOICE_NOT_SENT');
      if (!maySend()) throw executionError(CANCELLED_ACTION, 'VOICE_ACTION_CANCELLED');
      const token = session?.data?.session?.access_token;
      if (session?.error || typeof token !== 'string' || !token.trim()) {
        throw executionError(SIGN_IN_REQUIRED, 'VOICE_AUTH_REQUIRED');
      }
      let body;
      try { body = JSON.stringify({ tool, input }); }
      catch { throw executionError('This action could not be prepared. Nothing has been sent.', 'VOICE_NOT_SENT'); }

      // Do not retry: the server may have acted even if its response never arrives.
      sent = true;
      let response;
      let data;
      try {
        response = await request(url, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body,
        });
        data = await response.json();
      } catch {
        throw executionError(UNCERTAIN_RESULT, 'VOICE_RESULT_UNCERTAIN');
      }
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)
        || data.error || typeof data.result !== 'string' || !data.result.trim()) {
        throw executionError(UNCERTAIN_RESULT, 'VOICE_RESULT_UNCERTAIN');
      }
      // Preserve the actual result, including a result saying the action failed.
      // An HTTP success alone is not evidence that a booking or message succeeded.
      return data;
    })()]);
  } finally {
    clearTimeout(timer);
  }
}
