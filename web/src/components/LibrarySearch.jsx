import { useRef } from 'react';
import Frame from './Frame';
import SearchField from './SearchField';
import { compareKeepsLibrary, EMPTY_COPY, errorCopy, fmtTime } from '../lib/search';

function moveFocus(container, event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
  const items = [...(container?.querySelectorAll('[data-rail-item]') || [])];
  const at = items.indexOf(event.target);
  if (at < 0) return false;
  event.preventDefault();
  if (event.key === 'ArrowUp' && at === 0) return 'field';
  items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  return true;
}

function SearchHit({ result, onOpen }) {
  const moment = result.best;
  return (
    <button
      type="button"
      data-rail-item
      className="rail-hit library-item"
      onClick={() => onOpen({ videoId: result.videoId, ...moment })}
    >
      <Frame sprite={result.sprite} frame={moment.frame} width={28} />
      <span className="rail-hit-text">
        <span className="rail-hit-head">
          <span className="video-id">{result.videoId}</span>
          <span className="rail-hit-why">{moment.kind === 'video' ? 'whole video' : fmtTime(moment.tSec)}</span>
        </span>
        {moment.quote && <span className="library-item-desc">{moment.quote}</span>}
      </span>
    </button>
  );
}

/** The rail and the Search page share one query so both open the same second. */
export default function LibrarySearch({
  search,
  mode,
  videos,
  onOpen,
  onSeeAll,
  onJump,
  onOpenVideo,
  inputRef,
  listClassName = 'library-search-list scroll-pane scroll-pane-y',
  children,
}) {
  const { query, setQuery, clear, submit, status, results, notice, refining, busy, error, counts } = search;
  const listRef = useRef(null);
  const searching = Boolean(query.trim());
  const inSearch = mode === 'search';

  const field = (
    <div className="rail-search">
      <SearchField
        variant="rail"
        value={query}
        onChange={setQuery}
        onSubmit={() => {
          submit();
          if (!inSearch) onSeeAll();
        }}
        onClear={clear}
        onArrowDown={() => listRef.current?.querySelector('[data-rail-item]')?.focus()}
        busy={busy}
        inputRef={inputRef}
        placeholder="Search the Library"
      />
    </div>
  );

  if (!searching) {
    return (
      <>
        {field}
        {children}
      </>
    );
  }

  let note = '';
  if (status === 'error') note = errorCopy(error);
  else if (results.length === 0 && (busy || refining || status === 'idle')) note = 'Searching…';
  else if (status === 'done' && !refining && !busy && results.length === 0) note = EMPTY_COPY;
  else if (notice && !refining) note = notice;

  const onKeyDown = (event) => {
    if (moveFocus(listRef.current, event) === 'field') inputRef?.current?.focus();
  };

  if (compareKeepsLibrary(mode, { status, busy, refining, resultCount: results.length })) {
    return (
      <>
        {field}
        <p className="library-search-empty" aria-live="polite">
          {note || EMPTY_COPY}
        </p>
        {children}
      </>
    );
  }

  if (inSearch) {
    const byId = new Map(results.map((r, i) => [r.videoId, { result: r, order: i }]));
    const rest = videos.filter((v) => !byId.has(v.id));
    return (
      <>
        {field}
        <div ref={listRef} className={listClassName} onKeyDown={onKeyDown}>
          <p className="rail-map-note" aria-live="polite">
            {note || `${counts.videos} of ${videos.length} videos match`}
          </p>
          <ul className="rail-map">
            {results.map((r) => (
              <li key={r.videoId}>
                <button type="button" data-rail-item className="rail-map-item library-item" onClick={() => onJump(r.videoId)}>
                  <span className="video-id">{r.videoId}</span>
                  <span className="rail-map-count">
                    {r.momentCount || 1} {(r.momentCount || 1) === 1 ? 'moment' : 'moments'}
                  </span>
                </button>
              </li>
            ))}
            {rest.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  data-rail-item
                  className="rail-map-item library-item is-dim"
                  onClick={() => onOpenVideo(v.id)}
                  title="No match. Opens the video."
                >
                  <span className="video-id">{v.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  return (
    <>
      {field}
      <div ref={listRef} className={listClassName} onKeyDown={onKeyDown}>
        {note && (
          <p className="library-search-empty" aria-live="polite">
            {note}
          </p>
        )}
        {results.slice(0, 8).map((result) => (
          <SearchHit key={result.videoId} result={result} onOpen={onOpen} />
        ))}
        {results.length > 0 && (
          <button type="button" data-rail-item className="library-see-all" onClick={onSeeAll}>
            See all {counts.videos} results
          </button>
        )}
      </div>
    </>
  );
}

