import { receiptView, sourceLabel } from '../lib/receipt';

function quote(text, score, floor) {
  const body = String(text || '').trim();
  if (!body) return null;
  const value = score == null || score === '' ? null : Number(score);
  if (value != null && Number.isFinite(value) && floor != null && value < floor) return null;
  return body;
}

function Note({ source, sentence }) {
  return (
    <div className="playhead-extract-note">
      <p className="playhead-extract-kicker">{sourceLabel(source)}</p>
      <p className="playhead-extract-sub is-full">{sentence}</p>
    </div>
  );
}

export default function Receipt({ row, quoteFloor, searchNote }) {
  const view = receiptView(row);
  const floor = quoteFloor == null ? null : Number(quoteFloor);
  const speech = quote(view.speech, view.speechScore, floor);
  const screenLines = view.text
    .map((item) => quote(item.text, item.score, floor))
    .filter(Boolean);
  const screenText = screenLines.join(' ');
  const rawScreen = view.text.length > 0;
  const scenes = view.scenes.filter((item) => String(item?.sentence || '').trim());
  const outcomes = view.outcomes.filter((item) => String(item?.sentence || '').trim());
  const kept = view.ask?.phrase_en || view.ask?.phrase_original || (view.app ? 'the app screen' : '');
  const empty = !speech && !screenLines.length && !scenes.length && !rawScreen && !outcomes.length;

  return (
    <div className="playhead-extract">
      <div className="playhead-extract-kicker">This second</div>
      <div className="min-w-0">
        {speech && <p className="playhead-extract-line">Heard · {speech}</p>}
        {view.speech && !speech && (
          <p className="playhead-extract-sub">Heard line is too unclear to quote.</p>
        )}
        {screenText && (
          <div className="playhead-extract-note">
            <p className="playhead-extract-kicker">On screen</p>
            <p className="playhead-extract-line is-full">{screenText}</p>
          </div>
        )}
        {rawScreen && !screenLines.length && (
          <p className="playhead-extract-sub">On-screen text is too unclear to quote.</p>
        )}
        {scenes.length > 0 && (
          <div className="playhead-extract-note">
            <p className="playhead-extract-kicker">Scene</p>
            {scenes.map((scene) => (
              <Note
                key={`${scene.source}-${scene.sentence}`}
                source={scene.source}
                sentence={scene.sentence}
              />
            ))}
          </div>
        )}
        {kept && <p className="playhead-extract-sub">Both models kept {kept}.</p>}
        {outcomes.length > 0 && (
          <div className="playhead-extract-note">
            <p className="playhead-extract-kicker">Outcome</p>
            {outcomes.map((item) => (
              <Note
                key={`${item.source}-${item.sentence}`}
                source={item.source}
                sentence={item.sentence}
              />
            ))}
          </div>
        )}
        {empty && <p className="playhead-extract-line is-empty">Nothing was extracted at this second.</p>}
        {searchNote && <p className="playhead-extract-sub">{searchNote}</p>}
      </div>
    </div>
  );
}
