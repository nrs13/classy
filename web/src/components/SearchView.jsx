import { useId, useMemo, useRef, useState } from 'react';
import Frame from './Frame';
import SearchField from './SearchField';
import {
  CURATED_EXAMPLES,
  EMPTY_COPY,
  EMPTY_HINT,
  KINDS,
  MATCH_LABEL,
  countLine,
  errorCopy,
  fmtCount,
  fmtTime,
  highlightParts,
  langCode,
  langName,
  whyLine,
} from '../lib/search';

function Highlighted({ text, query, match }) {
  const parts = useMemo(() => highlightParts(text, query, match), [text, query, match]);
  return parts.map((part, i) =>
    part.hit ? (
      <mark key={i} className="sr-mark">
        {part.text}
      </mark>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  );
}

/** Where the moments sit in the video; each tick opens its moment. */
function Timeline({ duration, moments, onOpen }) {
  if (!(duration > 0)) return null;
  return (
    <div className="sr-timeline" role="group" aria-label="Where it matches in the video">
      <span className="sr-track" aria-hidden />
      {moments.map((m, i) => (
        <button
          key={`${m.tSec}-${m.kind}-${i}`}
          type="button"
          className={`sr-tick${i === 0 ? ' is-best' : ''}`}
          style={{ left: `${Math.min(100, Math.max(0, (m.tSec / duration) * 100))}%` }}
          onClick={() => onOpen(m)}
          aria-label={`Open at ${fmtTime(m.tSec)}`}
          title={fmtTime(m.tSec)}
          tabIndex={-1}
        />
      ))}
      <span className="sr-duration">{fmtTime(duration)}</span>
    </div>
  );
}

function Result({ result, query, onOpen }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const best = result.best;
  const more = result.more || [];
  const openMoment = (moment) => onOpen({ videoId: result.videoId, ...moment });
  const meta = [
    result.account,
    result.language ? langName(langCode(result.language)) : '',
    result.duration ? fmtTime(result.duration) : '',
    result.plays != null ? `${fmtCount(result.plays)} plays` : '',
  ].filter(Boolean);
  const hidden = Math.max(0, (result.momentCount || 0) - 1 - more.length);

  return (
    <article className="sr" id={`result-${result.videoId}`} aria-labelledby={`${listId}-id`}>
      <button
        type="button"
        className="sr-thumb"
        onClick={() => openMoment(best)}
        tabIndex={-1}
        aria-hidden
      >
        <Frame sprite={result.sprite} frame={best.frame} width={64} />
        <span className="sr-thumb-time">{best.kind === 'video' ? fmtTime(result.duration) : fmtTime(best.tSec)}</span>
      </button>
      <div className="sr-body">
        <header className="sr-head">
          <h3 className="sr-id video-id" id={`${listId}-id`}>
            {result.videoId}
          </h3>
          <span className="sr-meta">{meta.join(' · ')}</span>
          <span className={`sr-match is-${result.match}`}>{MATCH_LABEL[result.match] || ''}</span>
        </header>
        <Timeline duration={result.duration} moments={[best, ...more].filter((m) => m.kind !== 'video')} onOpen={openMoment} />
        <button type="button" className="sr-moment" data-result-moment onClick={() => openMoment(best)}>
          <span className="sr-why">
            {whyLine(best)}
            {best.speaker && <span className="sr-speaker">{best.speaker}</span>}
          </span>
          {best.before && <span className="sr-context">{best.before}</span>}
          <span className="sr-quote">
            <Highlighted text={best.quote} query={query} match={best.match} />
          </span>
          {best.after && <span className="sr-context">{best.after}</span>}
        </button>
        {more.length > 0 && (
          <>
            <button
              type="button"
              className="sr-more-toggle"
              aria-expanded={open}
              aria-controls={`${listId}-more`}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Fewer moments' : `${more.length} more ${more.length === 1 ? 'moment' : 'moments'}`}
            </button>
            {open && (
              <ul className="sr-more" id={`${listId}-more`}>
                {more.map((m, i) => (
                  <li key={`${m.tSec}-${m.kind}-${i}`}>
                    <button type="button" className="sr-more-row" onClick={() => openMoment(m)}>
                      <Frame sprite={result.sprite} frame={m.frame} width={28} />
                      <span className="sr-more-text">
                        <span className="sr-why">{whyLine(m)}</span>
                        <span className="sr-more-quote">
                          <Highlighted text={m.quote} query={query} match={m.match} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {hidden > 0 && <li className="sr-more-note">and {hidden} more in this video</li>}
              </ul>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="sr-list" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="sr sr-skeleton">
          <span className="frame is-empty" style={{ width: 64, height: 113 }} />
          <div className="sr-body">
            <span className="sk-line is-short" />
            <span className="sk-line is-track" />
            <span className="sk-line" />
            <span className="sk-line is-mid" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Kind filter as a segmented control; arrows move between options. */
function KindControl({ value, onChange }) {
  const refs = useRef([]);
  return (
    <div className="seg" role="radiogroup" aria-label="Where it appears">
      {KINDS.map((kind, i) => {
        const active = value === kind.id;
        return (
          <button
            key={kind.id || 'any'}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={`seg-option${active ? ' is-active' : ''}`}
            onClick={() => onChange(kind.id)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = (i + step + KINDS.length) % KINDS.length;
              onChange(KINDS[next].id);
              refs.current[next]?.focus();
            }}
          >
            {kind.label}
          </button>
        );
      })}
    </div>
  );
}

function AccountFilter({ accounts, value, onChange }) {
  const [text, setText] = useState('');
  const listId = useId();
  if (value) return null;
  return (
    <label className="filter-account">
      <span className="sr-only">Account</span>
      <input
        className="filter-input"
        list={listId}
        value={text}
        placeholder="Account"
        onChange={(event) => {
          const next = event.target.value;
          const exact = accounts.find((name) => name.toLowerCase() === next.trim().toLowerCase());
          if (exact) {
            onChange(exact);
            setText('');
          } else {
            setText(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const needle = text.trim().toLowerCase();
          const match = needle && accounts.find((name) => name.toLowerCase().includes(needle));
          if (match) {
            onChange(match);
            setText('');
          }
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {accounts.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </label>
  );
}

function Token({ label, onRemove }) {
  return (
    <span className="token">
      <span>{label}</span>
      <button type="button" className="token-x" onClick={onRemove} aria-label={`Remove ${label}`}>
        ×
      </button>
    </span>
  );
}

function Understood({ understood, literal, filters, onLiteral, onOnly }) {
  if (literal) {
    return (
      <p className="sx-understood">
        Searching exactly what you typed.{' '}
        <button type="button" className="sx-link" onClick={() => onLiteral(false)}>
          Search by meaning
        </button>
      </p>
    );
  }
  if (!understood) return null;
  const language = understood.languages?.[0];
  const offerOnly = language && !filters.lang;
  if (!understood.rewritten && !offerOnly) return null;
  return (
    <p className="sx-understood">
      {understood.rewritten && (
        <>
          Also searched as <q>{understood.english}</q>.{' '}
        </>
      )}
      {offerOnly && (
        <>
          {langName(language)} videos first.{' '}
          <button type="button" className="sx-link" onClick={() => onOnly(language)}>
            Only {langName(language)}
          </button>
          {understood.rewritten && ' · '}
        </>
      )}
      {understood.rewritten && (
        <button type="button" className="sx-link" onClick={() => onLiteral(true)}>
          Search exactly what I typed
        </button>
      )}
    </p>
  );
}

function Idle({ recent, examples, onPick, onRemove }) {
  return (
    <div className="sx-idle">
      {recent.length > 0 && (
        <section aria-labelledby="sx-recent">
          <h2 className="section-label" id="sx-recent">
            recent
          </h2>
          <ul className="sx-list">
            {recent.map((q) => (
              <li key={q} className="sx-row">
                <button type="button" className="sx-pick" onClick={() => onPick(q)}>
                  {q}
                </button>
                <button type="button" className="sx-remove" onClick={() => onRemove(q)} aria-label={`Remove ${q} from recent searches`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="sx-try">
        <h2 className="section-label" id="sx-try">
          try, in any language
        </h2>
        <ul className="sx-list">
          {CURATED_EXAMPLES.map((ex) => (
            <li key={ex.q} className="sx-row">
              <button type="button" className="sx-pick" onClick={() => onPick(ex.q)}>
                {ex.q}
              </button>
              <span className="sx-lang">{langName(ex.lang)}</span>
            </li>
          ))}
        </ul>
      </section>
      {examples.length > 0 && (
        <section aria-labelledby="sx-lines">
          <h2 className="section-label" id="sx-lines">
            lines from your library
          </h2>
          <ul className="sx-list">
            {examples.map((line) => (
              <li key={line} className="sx-row">
                <button type="button" className="sx-pick" onClick={() => onPick(`"${line}"`)}>
                  “{line}”
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Empty({ query, filters, literal, onClearFilters, onLiteral, onPick, understood }) {
  const filtered = Boolean(filters.lang || filters.field || filters.account);
  const unquoted = /^"[^"]+"$/.test(query) ? query.slice(1, -1).trim() : '';
  const scope = [
    filters.lang && `in ${langName(filters.lang)}`,
    filters.field && KINDS.find((k) => k.id === filters.field)?.label.toLowerCase(),
    filters.account && `from ${filters.account}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="sx-empty">
      <p className="sx-empty-title">
        {filtered ? (
          <>
            Nothing {scope} matches <q>{unquoted || query}</q>.
          </>
        ) : (
          EMPTY_COPY
        )}
      </p>
      <p className="sx-empty-hint">{filtered ? 'The rest of your Library may have it.' : EMPTY_HINT}</p>
      <div className="sx-actions">
        {filtered && (
          <button type="button" className="sx-button" onClick={onClearFilters}>
            Search everything
          </button>
        )}
        {unquoted && (
          <button type="button" className="sx-button" onClick={() => onPick(unquoted)}>
            Search without quotes
          </button>
        )}
        {literal && (
          <button type="button" className="sx-button" onClick={() => onLiteral(false)}>
            Search by meaning
          </button>
        )}
        {!literal && understood?.rewritten && (
          <button type="button" className="sx-button" onClick={() => onPick(understood.english)}>
            Try “{understood.english}”
          </button>
        )}
      </div>
    </div>
  );
}

function Failure({ error, onRetry }) {
  return (
    <div className="sx-empty" role="alert">
      <p className="sx-empty-title">{errorCopy(error)}</p>
      {error.kind !== 'offline' && (
        <div className="sx-actions">
          <button type="button" className="sx-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export default function SearchView({ search, videos, onOpen, inputRef, onArrowDownFromField, compact = false }) {
  const {
    query,
    setQuery,
    filters,
    setFilter,
    clearFilters,
    clear,
    submit,
    retry,
    literal,
    setLiteral,
    status,
    phase,
    results,
    notice,
    understood,
    refining,
    busy,
    stale,
    error,
    examples,
    recent,
    removeRecent,
    counts,
  } = search;
  const resultsRef = useRef(null);

  const languages = useMemo(() => {
    const codes = new Set(videos.map((v) => langCode(v.language)).filter(Boolean));
    return [...codes].sort((a, b) => langName(a).localeCompare(langName(b)));
  }, [videos]);
  const accounts = useMemo(() => {
    const names = new Set(videos.map((v) => v.account).filter(Boolean));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [videos]);

  const trimmed = query.trim();
  const english = !literal && understood?.rewritten ? understood.english : '';
  const marked = useMemo(() => (english ? [trimmed, english] : trimmed), [trimmed, english]);
  const hasResults = results.length > 0;
  const showSkeleton = trimmed && !hasResults && (busy || status === 'idle') && status !== 'error';
  const done = status === 'done' && !refining && !busy;

  const focusFirstResult = () => {
    const first = resultsRef.current?.querySelector('[data-result-moment]');
    if (first) first.focus();
    else onArrowDownFromField?.();
  };

  let statusLine = '';
  if (trimmed && status !== 'error') {
    if (hasResults) statusLine = countLine(counts) + (refining ? ' so far' : '');
    else if (done) statusLine = 'No results';
    else statusLine = 'Searching…';
  }

  return (
    <section className="search-view" aria-label="Search your Library">
      <div className="search-head">
        <SearchField
          variant="page"
          value={query}
          onChange={setQuery}
          onSubmit={() => submit()}
          onClear={clear}
          onArrowDown={focusFirstResult}
          busy={busy}
          inputRef={inputRef}
          placeholder={compact ? 'Search the Library' : undefined}
          describedBy="search-help"
        />
        <p className="search-help" id="search-help">
          Any language. Quotes match a phrase exactly.
        </p>
        <div className="search-filters" role="group" aria-label="Filters">
          <KindControl value={filters.field} onChange={(id) => setFilter('field', id)} />
          <label className={`filter-select${filters.lang ? ' is-set' : ''}`}>
            <span className="sr-only">Language</span>
            <select value={filters.lang} onChange={(event) => setFilter('lang', event.target.value)}>
              <option value="">Any language</option>
              {languages.map((code) => (
                <option key={code} value={code}>
                  {langName(code)}
                </option>
              ))}
            </select>
          </label>
          <AccountFilter accounts={accounts} value={filters.account} onChange={(name) => setFilter('account', name)} />
          {filters.account && <Token label={filters.account} onRemove={() => setFilter('account', '')} />}
          {(filters.lang || filters.field || filters.account) && (
            <button type="button" className="sx-link filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        <div className="search-status">
          <span className="sx-count" aria-live="polite" aria-atomic="true">
            {statusLine}
          </span>
          {phase === 'full' && notice && (
            <span className="sx-notice">
              {notice}{' '}
              <button type="button" className="sx-link" onClick={retry}>
                Retry
              </button>
            </span>
          )}
        </div>
        {trimmed && phase === 'full' && (
          <Understood
            understood={understood}
            literal={literal}
            filters={filters}
            onLiteral={setLiteral}
            onOnly={(code) => setFilter('lang', code)}
          />
        )}
      </div>

      {!trimmed ? (
        <Idle recent={recent} examples={examples} onPick={(q) => submit(q)} onRemove={removeRecent} />
      ) : status === 'error' ? (
        <Failure error={error} onRetry={retry} />
      ) : showSkeleton ? (
        <Skeleton />
      ) : done && !hasResults ? (
        <Empty
          query={trimmed}
          filters={filters}
          literal={literal}
          understood={understood}
          onClearFilters={clearFilters}
          onLiteral={setLiteral}
          onPick={(q) => submit(q)}
        />
      ) : (
        <div
          ref={resultsRef}
          className={`sr-list${stale ? ' is-stale' : ''}`}
          aria-busy={busy}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const items = [...(resultsRef.current?.querySelectorAll('[data-result-moment]') || [])];
            const at = items.indexOf(event.target);
            if (at < 0) return;
            event.preventDefault();
            if (event.key === 'ArrowUp' && at === 0) inputRef?.current?.focus();
            else items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
          }}
        >
          {results.map((result) => (
            <Result key={result.videoId} result={result} query={marked} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}
