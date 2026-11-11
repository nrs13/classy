import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addRecent, beginSearchState, dropRecent, ERROR_COPY, EXACT_COPY, loadRecent, resultCounts } from './search';
import { apiFetch } from './apiFetch.js';

/** Exact matches follow the keyboard; meaning and understanding wait for a pause or Enter. */
const EXACT_DELAY_MS = 120;
const FULL_DELAY_MS = 450;
/** Query understanding slower than the server's timeout finishes in the background; ask once more. */
const UNDERSTAND_RETRY_MS = 1500;
const CACHE_SIZE = 40;
const EMPTY_FILTERS = { lang: '', field: '', account: '' };
const IDLE = {
  status: 'idle',
  phase: null,
  results: [],
  notice: null,
  understood: null,
  refining: false,
  busy: false,
  stale: false,
  error: null,
};

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

function requestUrl(q, filters, { exact, literal }) {
  const params = new URLSearchParams({ q, limit: '20' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (exact) params.set('mode', 'exact');
  if (literal) params.set('understand', '0');
  return `/api/search?${params}`;
}

/** Errors carry a kind the UI can explain: rate, offline, unavailable or other. */
async function fetchSearch(url, signal) {
  let res;
  try {
    res = await apiFetch(url, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw Object.assign(new Error(ERROR_COPY), { kind: offline ? 'offline' : 'unavailable' });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const kind = res.status === 429 ? 'rate' : res.status >= 500 ? 'unavailable' : 'other';
    throw Object.assign(new Error(body?.message || ERROR_COPY), { kind, status: res.status });
  }
  return body;
}

function wholeQuoted(q) {
  return /^"[^"]+"$/.test(q);
}

function searchKeyOf(q, filters, literal) {
  return JSON.stringify([q, filters, literal]);
}

/** Earlier results stay visible while the slower search runs, so the list does not flash empty. */
export function useLibrarySearch(initial = {}) {
  const [query, setQueryState] = useState(initial.q || '');
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, ...(initial.filters || {}) });
  const [literal, setLiteral] = useState(false);
  const [submitNonce, setSubmitNonce] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [state, setState] = useState(IDLE);
  const [examples, setExamples] = useState([]);
  const [recent, setRecent] = useState(loadRecent);
  const cache = useRef(new Map());
  const snapshotRef = useRef('');
  const lastSubmit = useRef(0);

  const learnSnapshot = useCallback((snapshotId) => {
    if (!snapshotId || snapshotId === snapshotRef.current) return;
    if (snapshotRef.current) cache.current.clear();
    snapshotRef.current = snapshotId;
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchSearch('/api/search?q=&examples=1', ctrl.signal)
      .then((body) => {
        learnSnapshot(body.snapshotId);
        setExamples(Array.isArray(body.examples) ? body.examples : []);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [learnSnapshot]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState(IDLE);
      return undefined;
    }
    const immediate = submitNonce !== lastSubmit.current;
    lastSubmit.current = submitNonce;
    const keyOf = (pass) => JSON.stringify([snapshotRef.current, pass, q, filters, literal]);
    const forKey = searchKeyOf(q, filters, literal);
    const cached = cache.current.get(keyOf('full'));
    if (cached) {
      remember(cache.current, keyOf('full'), cached);
      setState({ ...IDLE, status: 'done', phase: 'full', ...cached, forKey });
      return undefined;
    }

    const ctrl = new AbortController();
    let fullDone = false;
    setState((prev) => beginSearchState(prev, forKey));

    const runExact = async () => {
      const key = keyOf('exact');
      try {
        const body = cache.current.get(key) || (await fetchSearch(requestUrl(q, filters, { exact: true }), ctrl.signal));
        if (ctrl.signal.aborted || fullDone) return;
        learnSnapshot(body.snapshotId);
        remember(cache.current, key, body);
        setState((prev) => ({
          ...prev,
          status: 'done',
          phase: 'exact',
          results: body.results || [],
          notice: null,
          understood: null,
          refining: true,
          stale: false,
        }));
      } catch {
        /* the full pass reports errors */
      }
    };

    let followTimer = null;
    const runFull = async (followUp = false) => {
      try {
        const body = await fetchSearch(requestUrl(q, filters, { literal }), ctrl.signal);
        if (ctrl.signal.aborted) return;
        fullDone = true;
        learnSnapshot(body.snapshotId);
        const value = {
          results: body.results || [],
          notice: body.notice || null,
          understood: body.understood || null,
        };
        const pending = body.understanding === 'pending' && !followUp;
        if (pending) {
          followTimer = setTimeout(() => runFull(true), UNDERSTAND_RETRY_MS);
        } else {
          remember(cache.current, keyOf('full'), value);
        }
        setState({ ...IDLE, status: 'done', phase: 'full', ...value, refining: pending, forKey });
      } catch (err) {
        if (err?.name === 'AbortError' || ctrl.signal.aborted) return;
        if (followUp) {
          setState((prev) => ({ ...prev, refining: false }));
          return;
        }
        fullDone = true;
        const error = { kind: err?.kind || 'other', message: err?.message || ERROR_COPY };
        setState((prev) =>
          prev.phase === 'exact' && !prev.stale && error.kind !== 'offline'
            ? { ...prev, refining: false, busy: false, notice: EXACT_COPY, retryable: true }
            : { ...IDLE, status: 'error', error, forKey },
        );
      }
    };

    const exactTimer = !wholeQuoted(q) && !immediate ? setTimeout(runExact, EXACT_DELAY_MS) : null;
    const fullTimer = setTimeout(() => runFull(), immediate ? 0 : FULL_DELAY_MS);
    return () => {
      if (exactTimer) clearTimeout(exactTimer);
      clearTimeout(fullTimer);
      if (followTimer) clearTimeout(followTimer);
      ctrl.abort();
    };
  }, [query, filters, literal, submitNonce, retryNonce, learnSnapshot]);

  useEffect(() => {
    function back() {
      setRetryNonce((n) => n + 1);
    }
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);

  const setQuery = useCallback((value) => {
    setQueryState(String(value ?? ''));
    setLiteral(false);
  }, []);

  // A click on a filter is deliberate: search at once instead of waiting for a pause.
  const setFilter = useCallback((name, value) => {
    setFilters((prev) => ({ ...prev, [name]: value }));
    setSubmitNonce((n) => n + 1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setSubmitNonce((n) => n + 1);
  }, []);

  const searchLiterally = useCallback((value) => {
    setLiteral(Boolean(value));
    setSubmitNonce((n) => n + 1);
  }, []);

  const clear = useCallback(() => {
    setQueryState('');
    setLiteral(false);
  }, []);

  const rememberQuery = useCallback((value) => {
    setRecent((list) => addRecent(list, value));
  }, []);

  const submit = useCallback(
    (value) => {
      const q = (value ?? query).trim();
      if (value !== undefined) setQuery(value);
      if (!q) return;
      rememberQuery(q);
      setSubmitNonce((n) => n + 1);
    },
    [query, setQuery, rememberQuery],
  );

  const retry = useCallback(() => {
    const key = JSON.stringify([snapshotRef.current, 'full', query.trim(), filters, literal]);
    cache.current.delete(key);
    setSubmitNonce((n) => n + 1);
    setRetryNonce((n) => n + 1);
  }, [query, filters, literal]);

  const removeRecent = useCallback((value) => setRecent((list) => dropRecent(list, value)), []);

  const counts = useMemo(() => resultCounts(state.results), [state.results]);
  // Between a keystroke and the effect that starts its search, the state still describes the
  // previous query: never present it as this query's empty result or error.
  const trimmed = query.trim();
  const behind = Boolean(trimmed) && state.forKey !== searchKeyOf(trimmed, filters, literal);
  const view = behind
    ? {
        ...state,
        status: state.status === 'error' ? 'idle' : state.status,
        busy: true,
        stale: state.results.length > 0,
        error: null,
      }
    : state;

  return {
    query,
    setQuery,
    filters,
    setFilter,
    clearFilters,
    clear,
    submit,
    retry,
    literal,
    setLiteral: searchLiterally,
    examples,
    recent,
    removeRecent,
    remember: rememberQuery,
    counts,
    ...view,
  };
}
