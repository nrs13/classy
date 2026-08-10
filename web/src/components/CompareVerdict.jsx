const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;

const SIGNALS = [
  {
    key: 'hook',
    label: 'hook',
    get: (v) => v.features?.hook_slope,
    fmt: (x) => x.toFixed(4),
    sentence: (id) => `${id} grabs attention fastest in the first seconds`,
  },
  {
    key: 'peak',
    label: 'peak',
    get: (v) => v.features?.peak_mean_abs,
    fmt: (x) => x.toFixed(3),
    sentence: (id) => `${id} hits the highest predicted engagement peak`,
  },
  {
    key: 'sustain',
    label: 'hold',
    get: (v) => v.features?.sustain_ratio,
    fmt: (x) => pct(x),
    sentence: (id) => `${id} holds attention best after the hook`,
  },
  {
    key: 'like_rate',
    label: 'like-rate',
    get: (v) => v.metrics?.like_rate,
    fmt: (x) => pct(x, 2),
    sentence: (id) => `${id} converts plays to likes best`,
  },
  {
    key: 'amplification',
    label: 'reach',
    get: (v) => v.metrics?.amplification,
    fmt: (x) => `${Math.round(x).toLocaleString()}×`,
    sentence: (id) => `${id} travels furthest beyond its followers`,
  },
];

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
    const worst = Math.min(...valid.map((entry) => entry.value));
    if (best === worst) continue;
    const winner = valid.find((entry) => entry.value === best);
    rows.push({ signal, values, winner });
  }
  return rows;
}

/**
 * Proactive plain-language comparison so a first-time viewer gets the verdict
 * without asking chat. Winner per signal, values for every compared reel.
 */
export default function CompareVerdict({ videos }) {
  const rows = signalRows(videos);
  if (!rows.length) return null;

  const wins = new Map();
  for (const row of rows) {
    wins.set(row.winner.id, (wins.get(row.winner.id) || 0) + 1);
  }
  const [leaderId, leaderWins] = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];

  return (
    <section className="compare-verdict" aria-label="Automatic comparison verdict">
      <div className="compare-verdict-headline">
        <span className="compare-verdict-leader">{leaderId}</span> leads on {leaderWins} of{' '}
        {rows.length} signals
      </div>
      <div className="compare-verdict-rows">
        {rows.map(({ signal, values, winner }) => (
          <div key={signal.key} className="compare-verdict-row">
            <span className="compare-verdict-tag">{signal.label}</span>
            <span className="compare-verdict-sentence">{signal.sentence(winner.id)}</span>
            <span className="compare-verdict-values">
              {values.map((entry) => (
                <span
                  key={entry.id}
                  className={`compare-verdict-value${
                    entry.id === winner.id ? ' is-winner' : ''
                  }`}
                >
                  {entry.id} {entry.value == null ? '–' : signal.fmt(entry.value)}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="compare-verdict-footnote">
        hook, peak and hold are predicted brain response (TRIBE V2) · like-rate and reach are
        observed · n=10 pilot, descriptive only
      </div>
    </section>
  );
}
