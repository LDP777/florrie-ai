/** Read with the current session; a rejected token gets one refresh attempt. */
export async function readActivity({ auth, request, url }) {
  let sessionResult = await auth.getSession();
  if (sessionResult.error || !sessionResult.data?.session?.access_token) {
    throw new Error('Your session is unavailable. Sign in again to load activity.');
  }
  const send = token => request(url, { headers: { Authorization: `Bearer ${token}` } });
  let response = await send(sessionResult.data.session.access_token);
  if (response.status === 401) {
    sessionResult = await auth.refreshSession();
    if (sessionResult.error || !sessionResult.data?.session?.access_token) {
      throw new Error('Your session has expired. Sign in again to load activity.');
    }
    response = await send(sessionResult.data.session.access_token);
  }
  if (!response.ok) throw new Error('Could not load activity. Please try again.');
  const body = await response.json();
  if (!Array.isArray(body?.rows)) throw new Error('Could not load activity. Please try again.');
  return body.rows;
}
