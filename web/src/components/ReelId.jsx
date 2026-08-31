export default function ReelId({
  id,
  variant = 'plain',
  winner = false,
  onDark = false,
  className = '',
}) {
  if (!id) return null;

  const cls = [
    'reel-id',
    `reel-id--${variant}`,
    onDark ? 'reel-id--on-dark' : '',
    winner ? 'is-winner' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls}>
      <span className="reel-id-text">{id}</span>
    </span>
  );
}
