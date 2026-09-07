// Commands are never retried automatically: the server may have acted even
// when the connection drops before its response reaches the phone.
export async function sendVoiceCommand({ auth, url, text, request = fetch, timeoutMs = 45000 }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Florrie took too long to respond. Check the result before repeating an action.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const session = await auth.getSession();
      if (controller.signal.aborted) throw new Error('The request timed out before it was sent.');
      const token = session.data?.session?.access_token;
      if (session.error || !token) throw new Error('Sign in again to use Florrie. Your request has not been sent.');
      const response = await request(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Florrie could not complete that request.');
      if (!data || typeof data !== 'object' || (!data.reply && !data.proposals?.length)) throw new Error('Florrie returned no answer. Check the result before repeating an action.');
      return data;
    })()]);
  } finally { clearTimeout(timer); }
}
