import { REPLY_MODES, normalizeReplyModes } from '../lib/replyModes';

export default function ReplyModeGroup({ value, onChange, disabled = false }) {
  const active = normalizeReplyModes(value);
  const isLastActive = active.length === 1;

  return (
    <div
      className="composer-modes"
      role="group"
      aria-label="Reply mode, combine one or more"
    >
      {REPLY_MODES.map((mode) => {
        const on = active.includes(mode.id);
        const locked = on && isLastActive;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={on}
            className={`composer-mode${on ? ' is-active' : ''}`}
            onClick={() => onChange(mode.id)}
            disabled={disabled}
            title={
              locked
                ? `${mode.label}: ${mode.hint} (keep at least one mode on)`
                : `${mode.label}: ${mode.hint}`
            }
          >
            <span className="composer-mode-name">{mode.label}</span>
          </button>
        );
      })}
    </div>
  );
}
