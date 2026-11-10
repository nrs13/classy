import { useEffect, useState } from 'react';
import { COUNT_FROM, MAX_QUERY } from '../lib/search';

const SLOW_MS = 400;

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden focusable="false">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function ReturnGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path d="M13 3v6H4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 6 3.5 9l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** One field serves the rail and the Search page so the query does not split. */
export default function SearchField({
  value,
  onChange,
  onSubmit,
  onClear,
  onArrowDown,
  busy = false,
  variant = 'page',
  inputRef,
  placeholder = 'Search what was said, shown or happens',
  describedBy,
  id,
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const length = [...value].length;
  const hasText = value.trim().length > 0;

  return (
    <form
      role="search"
      className={`sf sf-${variant}${busy ? ' is-busy' : ''}${hasText ? ' has-text' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (hasText) onSubmit?.();
      }}
    >
      <span className="sf-glyph" aria-hidden>
        {slow ? <span className="sf-spinner" /> : <SearchGlyph />}
      </span>
      <input
        ref={inputRef}
        id={id}
        className="sf-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (value) {
              event.preventDefault();
              event.stopPropagation();
              onClear?.();
            } else {
              event.currentTarget.blur();
            }
          } else if (event.key === 'ArrowDown' && onArrowDown) {
            event.preventDefault();
            onArrowDown();
          }
        }}
        placeholder={placeholder}
        aria-label="Search your Library"
        aria-describedby={describedBy}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        maxLength={MAX_QUERY}
      />
      {length > COUNT_FROM && (
        <span className={`sf-count${length >= MAX_QUERY ? ' is-full' : ''}`} aria-live="polite">
          {length}/{MAX_QUERY}
        </span>
      )}
      {value && (
        <button
          type="button"
          className="sf-clear"
          aria-label="Clear search"
          onClick={() => {
            onClear?.();
            inputRef?.current?.focus();
          }}
        >
          <ClearGlyph />
        </button>
      )}
      <button type="submit" className="sf-submit" aria-label="Search" disabled={!hasText}>
        {variant === 'page' && <span className="sf-kbd">Enter</span>}
        <ReturnGlyph />
      </button>
      <span className="sf-progress" aria-hidden />
    </form>
  );
}
