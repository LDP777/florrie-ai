import { readAuthenticatedJson } from './authenticated-json.js';

/** Read with a bounded request and one refresh for a rejected session. */
export async function readActivity({ auth, request, url }) {
  const body = await readAuthenticatedJson({ auth, request, url });
  if (!Array.isArray(body?.rows)) throw new Error('Could not load activity. Please try again.');
  return body.rows;
}
