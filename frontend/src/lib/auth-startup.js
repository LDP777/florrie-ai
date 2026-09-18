const STARTUP_ERROR = 'We couldn’t check your sign-in. Check your connection, then try again.';

/**
 * Observe auth before reading its initial state. A failed or stalled read is
 * unknown, not signed out: never clear storage or call signOut to recover it.
 * Supabase auth calls cannot be aborted, so generations make late results inert.
 */
export function startAuthStartup({ auth, onChange, timeoutMs = 8_000, retryDelayMs = 500 }) {
  let disposed = false;
  let generation = 0;
  let attemptId = 0;
  let timer;
  let retryTimer;
  let subscription;
  let state = { status: 'loading', session: null, error: null };

  const publish = next => {
    state = next;
    if (!disposed) onChange(state);
  };
  const clearTimers = () => {
    clearTimeout(timer);
    clearTimeout(retryTimer);
  };
  const accept = session => {
    if (disposed) return;
    generation++;
    clearTimers();
    publish({ status: 'ready', session, error: null });
  };

  function readSession(run, attempt) {
    const id = ++attemptId;
    let settled = false;
    const current = () => !disposed && generation === run && attemptId === id && !settled;
    const failed = () => {
      if (!current()) return;
      settled = true;
      clearTimeout(timer);
      if (attempt < 2) {
        retryTimer = setTimeout(() => {
          if (!disposed && generation === run) readSession(run, attempt + 1);
        }, retryDelayMs);
      } else {
        publish({ ...state, status: 'error', error: STARTUP_ERROR });
      }
    };
    timer = setTimeout(failed, timeoutMs);
    Promise.resolve().then(() => current() ? auth.getSession() : undefined).then(result => {
      if (!current()) return;
      if (result?.error || !result?.data || !Object.hasOwn(result.data, 'session')) {
        failed();
        return;
      }
      const session = result.data.session;
      if (session !== null && (typeof session !== 'object' || !session?.user?.id || !session?.access_token)) {
        failed();
        return;
      }
      settled = true;
      accept(session);
    }).catch(failed);
  }

  function begin() {
    if (disposed) return;
    const run = ++generation;
    clearTimers();
    publish({ ...state, status: 'loading', error: null });
    try {
      if (!subscription) {
        subscription = auth.onAuthStateChange((event, session) => {
          if (event === 'INITIAL_SESSION' && state.status === 'ready') return;
          // Supabase also emits INITIAL_SESSION with null when its initial
          // read fails. Only an error-free getSession result confirms an
          // anonymous startup. A real sign-out must win over an older read.
          if (session?.user?.id && session?.access_token) accept(session);
          else if (event === 'SIGNED_OUT') accept(null);
        }).data.subscription;
      }
      // Some providers emit their initial state synchronously on subscription.
      if (generation === run) readSession(run, 1);
    } catch {
      publish({ ...state, status: 'error', error: STARTUP_ERROR });
    }
  }

  begin();
  return {
    retry() {
      if (!disposed && state.status === 'error') begin();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearTimers();
      subscription?.unsubscribe();
    },
  };
}
