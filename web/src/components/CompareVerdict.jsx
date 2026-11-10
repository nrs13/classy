import { useState } from 'react';
import VideoId from './VideoId';

const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;

const SIGNALS = [
  {
    key: 'hook',
    label: 'hook',
    kind: 'predicted',
    get: (v) => v.features?.hook_slope,
    fmt: (x) => x.toFixed(4),
    sentence: (id) => (
      <>
        <VideoId id={id} variant="inline" /> grabs attention fastest in the first seconds
      </>
    ),
  },
  {
    key: 'peak',
    label: 'peak',
    kind: 'predicted',
    get: (v) => v.features?.peak_mean_abs,
    fmt: (x) => x.toFixed(3),
    sentence: (id) => (
      <>
        <VideoId id={id} variant="inline" /> hits the highest predicted engagement peak
      </>
    ),
  },
  {
    key: 'sustain',
    label: 'hold',
    kind: 'predicted',
    get: (v) => v.features?.sustain_ratio,
    fmt: (x) => pct(x),
    sentence: (id) => (
      <>
        <VideoId id={id} variant="inline" /> holds attention best after the hook
      </>
    ),
  },
  {
    key: 'like_rate',
    label: 'like-rate',
    kind: 'observed',
    get: (v) => v.metrics?.like_rate,
    fmt: (x) => pct(x, 2),
    sentence: (id) => (
      <>
        <VideoId id={id} variant="inline" /> converts plays to likes best
      </>
    ),
  },
  {
    key: 'amplification',
    label: 'reach',
    kind: 'observed',
    get: (v) => v.metrics?.amplification,
    fmt: (x) => `${Math.round(x).toLocaleString()}×`,
    sentence: (id) => (
      <>
        <VideoId id={id} variant="inline" /> travels furthest beyond its followers
      </>
    ),
  },
];

function footnote(n) {
  const predicted = SIGNALS.filter((s) => s.kind === 'predicted').map((s) => s.label).join(', ');
  const observed = SIGNALS.filter((s) => s.kind === 'observed').map((s) => s.label).join(' and ');
  return `${predicted} are predicted brain response (TRIBE V2) · ${observed} are observed · n=${n} pilot, descriptive only`;
}

function signalRows(videos) {
  const rows = [];
  for (const signal of SIGNALS) {
    const values = videos.map((v) => {
      const raw = Number(signal.get(v));
      return { id: v.id, value: Number.isFinite(raw) ? raw : null };
    });
    const valid = values.filter((entry) => entry.value != null);
    if (valid.length < 2) continue;
    const best = Math.max(...valid.map((entry) => entry.value));
    if (valid.every((entry) => entry.value === best)) continue;
    const winner = valid.find((entry) => entry.value === best);
    rows.push({ signal, values, winner });
  }
  return rows;
}

function leaderStats(rows) {
  const wins = {};
  for (const row of rows) {
    wins[row.winner.id] = (wins[row.winner.id] || 0) + 1;
  }
  let leaderId = rows[0].winner.id;
  let leaderWins = 0;
  for (const [id, count] of Object.entries(wins)) {
    if (count > leaderWins) {
      leaderId = id;
      leaderWins = count;
    }
  }
  return { leaderId, leaderWins };
}

function CompareVerdictSummary({ leaderId, leaderWins, rowCount, open, onToggle }) {
  return (
    <section className="compare-verdict-bar" aria-label="Compare signals">
      <button
        type="button"
        className="compare-verdict-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="compare-verdict-headline">
          <VideoId id={leaderId} variant="inline" /> leads on {leaderWins} of {rowCount} signals
        </span>
        <span className="compare-verdict-chevron" aria-hidden />
      </button>
    </section>
  );
}

function CompareVerdictDetails({ rows, n, footnoteOpen, setFootnoteOpen }) {
  return (
    <div className="compare-verdict-body">
      <div className="compare-verdict-grid">
        {rows.map(({ signal, values, winner }) => (
          <article key={signal.key} className="compare-signal-card" data-kind={signal.kind}>
            <div className="compare-signal-head">
              <span className="compare-signal-label">{signal.label}</span>
              <span className="compare-signal-kind">{signal.kind}</span>
            </div>
            <p className="compare-signal-sentence">{signal.sentence(winner.id)}</p>
            <div className="compare-signal-rows">
              {values.map((entry) => (
                <div
                  key={entry.id}
                  className={`compare-signal-row${entry.id === winner.id ? ' is-winner' : ''}`}
                >
                  <VideoId id={entry.id} variant="stage" winner={entry.id === winner.id} />
                  <span className="compare-signal-val">
                    {entry.value == null ? 'n/a' : signal.fmt(entry.value)}
                  </span>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="compare-verdict-footnote-row">
        <button
          type="button"
          className="compare-verdict-footnote-toggle"
          aria-expanded={footnoteOpen}
          onClick={() => setFootnoteOpen((v) => !v)}
        >
          ⓘ methodology
        </button>
        {footnoteOpen && <p className="compare-verdict-footnote">{footnote(n)}</p>}
      </div>
    </div>
  );
}

export function CompareVerdictLayout({ videos, controls, children }) {
  const rows = signalRows(videos);
  const [open, setOpen] = useState(true);
  const [footnoteOpen, setFootnoteOpen] = useState(false);

  const hasVerdict = rows.length > 0;
  const { leaderId, leaderWins } = hasVerdict ? leaderStats(rows) : {};

  return (
    <>
      <div className="compare-head">
        {controls}
        {hasVerdict && (
          <CompareVerdictSummary
            leaderId={leaderId}
            leaderWins={leaderWins}
            rowCount={rows.length}
            open={open}
            onToggle={() => setOpen((v) => !v)}
          />
        )}
      </div>
      <div className="compare-scroll scroll-pane scroll-pane-y">
        {hasVerdict && open && (
          <CompareVerdictDetails
            rows={rows}
            n={videos.length}
            footnoteOpen={footnoteOpen}
            setFootnoteOpen={setFootnoteOpen}
          />
        )}
        {children}
      </div>
    </>
  );
}
