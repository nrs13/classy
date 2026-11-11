import { REPLY_MODES, normalizeReplyModes } from '../lib/replyModes';

export default function ReplyModeGroup({ value, onChange, disabled = false }) {
  const active = normalizeReplyModes(value);

  return (
    <div
      className="composer-modes"
      role="group"
      aria-label="Reply lenses. Select none, one, or more."
    >
      {REPLY_MODES.map((mode) => {
        const on = active.includes(mode.id);
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={on}
            className={`composer-mode${on ? ' is-active' : ''}`}
            onClick={() => onChange(mode.id)}
            disabled={disabled}
            title={`${mode.label}: ${mode.hint}`}
          >
            <span className="composer-mode-name">{mode.label}</span>
          </button>
        );
      })}
    </div>
  );
}
