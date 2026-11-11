import { useEffect, useState } from 'react';

const ASPECT = 170 / 96;

/** Frames share one sprite so a result list does not download the sheet once per moment. */
export default function Frame({ sprite, frame, width = 48, className = '' }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const height = Math.round(width * ASPECT);
  const usable = sprite && frame && !failed && sprite.cols > 0 && sprite.rows > 0;
  const src = sprite?.url
    ? (attempt ? `${sprite.url}${sprite.url.includes('?') ? '&' : '?'}retry=${attempt}` : sprite.url)
    : '';
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [sprite?.url]);
  return (
    <span className={`frame${usable ? '' : ' is-empty'} ${className}`} style={{ width, height }} aria-hidden>
      {usable && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => {
            if (attempt < 1) setAttempt(1);
            else setFailed(true);
          }}
          style={{
            width: sprite.cols * width,
            height: sprite.rows * height,
            transform: `translate(${-frame.col * width}px, ${-frame.row * height}px)`,
          }}
        />
      )}
    </span>
  );
}
