export async function readOAuthProviders({ url, key, fetchImpl = fetch }) {
  if (!url || !key) throw new Error('Authentication is not configured');
  const response = await fetchImpl(`${url}/auth/v1/settings`, {
    headers: { apikey: key }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Authentication settings unavailable');
  const settings = await response.json();
  return { apple: settings?.external?.apple === true, google: settings?.external?.google === true };
}
