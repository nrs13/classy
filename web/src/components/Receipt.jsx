import { receiptView } from '../lib/receipt';
import { secondText } from '../lib/secondText';

function quote(text, score, floor) {
  const body = String(text || '').trim();
  if (!body) return null;
  const value = score == null || score === '' ? null : Number(score);
  if (value != null && Number.isFinite(value) && floor != null && value < floor) return null;
  return body;
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
  const understanding = secondText(row);
  const kept = view.ask?.phrase_en || view.ask?.phrase_original || (view.app ? 'the app screen' : '');
  const empty = !speech && !screenLines.length && !understanding && !rawScreen;

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
        {understanding && (
          <div className="playhead-extract-note">
            <p className="playhead-extract-kicker">Content understanding</p>
            <p className="playhead-extract-line is-full">{understanding}</p>
          </div>
        )}
        {kept && <p className="playhead-extract-sub">Both models kept {kept}.</p>}
        {empty && <p className="playhead-extract-line is-empty">Nothing was extracted at this second.</p>}
        {searchNote && <p className="playhead-extract-sub">{searchNote}</p>}
      </div>
    </div>
  );
}
