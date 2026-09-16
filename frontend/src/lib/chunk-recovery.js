const KEY = 'florrie.chunk-recovery-at';
const WINDOW_MS = 120_000;
export function isChunkLoadError(error) {
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|error loading dynamically imported module/i.test(error?.message || '');
}
// Only a rendered error boundary invokes this. Background prefetch failures must
// never reload an open form. Keep auth storage intact and never loop offline.
export function recoverMissingChunk({ error, native = false, storage, reload, now = Date.now() }) {
  if (native || !isChunkLoadError(error)) return false;
  try {
    const previous = Number(storage.getItem(KEY));
    if (previous > 0 && now - previous < WINDOW_MS) return false;
    storage.setItem(KEY, String(now));
    reload();
    return true;
  } catch { return false; }
}
