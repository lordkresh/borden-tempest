/**
 * Zero-dependency async ES-module test framework with strict live-network leakage guard
 * and unhandled rejection / uncaught error trapping.
 */

const NATIVE_FETCH = window.fetch.bind(window);
const LOCAL_ORIGIN = window.location.origin;

export const suiteState = {
  tests: [],
  results: [],
  unhandledRejections: [],
  uncaughtErrors: [],
  liveNetworkLeaks: []
};

function strictGuardedFetch(input, init) {
  const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
  let resolved;
  try {
    resolved = new URL(rawUrl, LOCAL_ORIGIN);
  } catch {
    resolved = { origin: 'unknown', href: rawUrl };
  }
  if (resolved.origin !== LOCAL_ORIGIN) {
    const msg = `LIVE_NETWORK_LEAKAGE: Unmocked fetch attempted to external URL: ${resolved.href}`;
    suiteState.liveNetworkLeaks.push(msg);
    return Promise.reject(new Error(msg));
  }
  return NATIVE_FETCH(input, init);
}

// Install strict leakage guard immediately
window.fetch = strictGuardedFetch;

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  suiteState.unhandledRejections.push(msg);
});

window.addEventListener('error', (ev) => {
  suiteState.uncaughtErrors.push(`${ev.message} (${ev.filename}:${ev.lineno})`);
});

let currentGroup = 'default';

export function describe(name, fn) {
  const prev = currentGroup;
  currentGroup = name;
  try {
    fn();
  } finally {
    currentGroup = prev;
  }
}

export function test(name, fn) {
  suiteState.tests.push({ group: currentGroup, name, fn });
}

export async function withMockFetch(mockImpl, callback) {
  const prevFetch = window.fetch;
  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
    return mockImpl(rawUrl, init);
  };
  try {
    return await callback();
  } finally {
    window.fetch = prevFetch;
  }
}

export function assert(cond, msg = 'Assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tol = 1e-3, msg = '') {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected finite number ~${expected}, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual} (diff=${Math.abs(actual - expected)})`);
  }
}

export function assertFinite(val, msg = '') {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected finite number, got ${val}`);
  }
}

export function assertNoNaNDeep(obj, path = 'root') {
  if (typeof obj === 'number') {
    if (Number.isNaN(obj)) throw new Error(`NaN detected at ${path}`);
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((v, idx) => assertNoNaNDeep(v, `${path}[${idx}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    assertNoNaNDeep(v, `${path}.${k}`);
  }
}

export async function runAllUnitTests() {
  suiteState.results = [];
  const startAll = performance.now();
  for (const t of suiteState.tests) {
    const rejBefore = suiteState.unhandledRejections.length;
    const errBefore = suiteState.uncaughtErrors.length;
    const leakBefore = suiteState.liveNetworkLeaks.length;
    const t0 = performance.now();
    try {
      await t.fn();
      // Give microtasks one tick to surface any floating unhandled rejection
      await new Promise((r) => setTimeout(r, 5));
      if (suiteState.unhandledRejections.length > rejBefore) {
        throw new Error(`Unhandled rejection during test: ${suiteState.unhandledRejections[rejBefore]}`);
      }
      if (suiteState.uncaughtErrors.length > errBefore) {
        throw new Error(`Uncaught error during test: ${suiteState.uncaughtErrors[errBefore]}`);
      }
      if (suiteState.liveNetworkLeaks.length > leakBefore) {
        throw new Error(`Live network leak during test: ${suiteState.liveNetworkLeaks[leakBefore]}`);
      }
      suiteState.results.push({
        group: t.group,
        name: t.name,
        passed: true,
        durationMs: Math.round((performance.now() - t0) * 10) / 10
      });
    } catch (err) {
      suiteState.results.push({
        group: t.group,
        name: t.name,
        passed: false,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const passed = suiteState.results.filter((r) => r.passed).length;
  const failed = suiteState.results.length - passed;
  return {
    total: suiteState.results.length,
    passed,
    failed,
    durationMs: Math.round(performance.now() - startAll),
    unhandledRejections: suiteState.unhandledRejections,
    uncaughtErrors: suiteState.uncaughtErrors,
    liveNetworkLeaks: suiteState.liveNetworkLeaks,
    results: suiteState.results
  };
}
