import { normalizeReplyModes } from './replyModes.js';

export function normalizeFocus(raw) {
  const ids = Array.isArray(raw?.ids)
    ? [...new Set(raw.ids.filter((id) => typeof id === 'string' && id.trim()))].slice(0, 4)
    : [];
  const t = Number(raw?.timeSec);
  const requested = Array.isArray(raw?.modes)
    ? raw.modes
    : typeof raw?.mode === 'string'
      ? [raw.mode]
      : [];
  const view = raw?.view === 'explore' || raw?.view === 'compare' || raw?.view === 'search' ? raw.view : '';
  return {
    ids,
    timeSec: Number.isFinite(t) && t >= 0 ? t : null,
    modes: normalizeReplyModes(requested),
    view,
  };
}

export function deliverOpenClip(knowledge, focus) {
  const ids = Array.isArray(focus?.ids) ? focus.ids : [];
  if (!ids.length || !Array.isArray(knowledge?.videos)) return knowledge;
  const t = Number(focus?.timeSec) || 0;
  const videos = knowledge.videos
    .filter((video) => video?.id && ids.includes(video.id))
    .map((video) => {
      const story = Array.isArray(video.story) ? video.story : [];
      let best = null;
      let bestDist = Infinity;
      for (const row of story) {
        const dist = Math.abs(Number(row?.t_sec) - t);
        if (dist < bestDist) {
          bestDist = dist;
          best = row;
        }
      }
      const sec = best ? Math.floor(Number(best.t_sec)) : Math.floor(t);
      const events = (video.content_events || []).filter(
        (event) => Math.floor(Number(event?.t_sec)) === sec,
      );
      return {
        ...video,
        story: best ? [best] : [],
        content_events: events,
      };
    });
  return {
    ...knowledge,
    delivery: 'open-clip',
    videos,
    n: videos.length,
    scope:
      videos.length > 1
        ? 'The compared clips, a short window around the playhead, and any moment the question names.'
        : 'The open clip, a short window around the playhead, and any moment the question names.',
  };
}
