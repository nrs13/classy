export default function VideoId({
  id,
  variant = 'plain',
  winner = false,
  onDark = false,
  className = '',
}) {
  if (!id) return null;

  const cls = [
    'video-id',
    `video-id--${variant}`,
    onDark ? 'video-id--on-dark' : '',
    winner ? 'is-winner' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls}>
      <span className="video-id-text">{id}</span>
    </span>
  );
}
