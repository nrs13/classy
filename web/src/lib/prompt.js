import { normalizeReplyModes } from './replyModes.js';
import { sentencesAt } from './forecast.js';

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
  return {
    ids,
    timeSec: Number.isFinite(t) && t >= 0 ? t : null,
    modes: normalizeReplyModes(requested),
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
      const clip = {
        ...video,
        open_second: best,
        story: best ? [best] : [],
        content_events: events,
      };
      const lines = sentencesAt(video, t);
      if (lines.length) clip.forecast_at_second = lines;
      return clip;
    });
  return {
    ...knowledge,
    delivery: 'open-clip',
    videos,
    n: videos.length,
    scope:
      videos.length > 1
        ? 'The compared videos at the shared second. The rest of the Library is not in this payload.'
        : 'The open video and the open second. The rest of the Library is not in this payload.',
  };
}

export function openClipPreamble(knowledge, focus) {
  const t = Number(focus?.timeSec);
  const at = Number.isFinite(t) ? ` The playhead is at about ${t.toFixed(1)} seconds.` : '';
  return `You are the analyst inside Classy. The DATA below is the open clip and the open second, not the rest of the library.${at}

Answer from that record.
- This is predicted TRIBE V2 cortical encoding, not a measured brain.
- Do not say a cut, a face, speech, an app screen, or an ask earned saves or caused the activation.
- Do not invent a save score or a virality score. Counts on the clip are the public record.
- If forecast_at_second is present, those sentences are the only cut result. Quote their shared ranges. Do not swap in a mean, and do not describe limbic cortex as that result.
- If a field is missing, say it was not extracted at this second.
- Plain text only. No markdown, no asterisks, no LaTeX.
- Two or three short sentences.

DATA (JSON):
${JSON.stringify(knowledge)}`;
}
