/**
 * The minimum browser a Florrie page needs in order to render once in node.
 *
 * There are three harnesses now — the render check, the screenshot tool and the
 * overflow check — and they all need the same globals. The first time they
 * diverged, the overflow check died inside PostHog on `addEventListener is not
 * a function`, which is a fact about the stub and looks exactly like a fact
 * about the app. One copy.
 *
 * Everything here does nothing on purpose. A page must be able to TOUCH these
 * without the harness exploding, and must not be able to make anything happen.
 */
const noop = () => {};
const store = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 };

export function installDomStub() {
  globalThis.window ??= globalThis;

  // Pages read window.location directly (Inbox pulls ?client= out of the query)
  // and node's globalThis has none, so without this the harness reports an app
  // crash that is really a hole in the harness.
  globalThis.location ??= new URL('http://localhost/');
  globalThis.history ??= { length: 1, pushState: noop, replaceState: noop, back: noop, go: noop, state: null };

  globalThis.localStorage ??= store;
  globalThis.sessionStorage ??= store;
  globalThis.matchMedia ??= () => ({ matches: false, media: '', onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false });

  // Analytics and error reporting both attach listeners at import time.
  globalThis.addEventListener ??= noop;
  globalThis.removeEventListener ??= noop;
  globalThis.dispatchEvent ??= () => false;

  globalThis.requestAnimationFrame ??= noop;
  globalThis.cancelAnimationFrame ??= noop;
  globalThis.requestIdleCallback ??= noop;
  globalThis.scrollTo ??= noop;
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '', overflowX: 'visible', overflowY: 'visible' });
  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return []; } };

  // Resolve immediately with an empty payload rather than never resolving. A
  // pending promise looks harmless and is not: a component that suspends on it
  // makes renderToString hang forever, turning a fast check into a build that
  // never finishes.
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({}), text: async () => '', blob: async () => null,
    clone() { return this; },
  });

  const el = () => ({
    style: {}, dataset: {}, children: [], childNodes: [],
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, removeChild: noop, remove: noop, insertBefore: noop,
    addEventListener: noop, removeEventListener: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  });

  globalThis.document ??= {
    documentElement: { ...el(), style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' } },
    body: el(),
    head: el(),
    cookie: '',
    referrer: '',
    title: 'Florrie',
    readyState: 'complete',
    visibilityState: 'visible',
    createElement: el,
    createTextNode: () => ({}),
    createDocumentFragment: el,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };
}
