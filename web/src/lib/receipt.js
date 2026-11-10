function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        return String(item?.text || item?.content || '').trim();
      })
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[]') return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return textItems(parsed);
    } catch {
      // A line that is not JSON is already the text.
    }
    return [trimmed];
  }
  return [];
}

function labelItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const name = String(item?.name || item?.text || '').trim();
      if (!name) return null;
      return { name, score: asNumber(item?.score) };
    })
    .filter(Boolean);
}

export function secondsFromRecord(record) {
  if (Array.isArray(record?.seconds) && record.seconds.length) return record.seconds;
  const story = Array.isArray(record?.story) ? record.story : [];
  const events = Array.isArray(record?.content_events) ? record.content_events : [];
  const times = new Set();
  for (const row of story) times.add(Number(row.t_sec));
  for (const event of events) times.add(Number(event.t_sec));
  const seconds = [...times]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
    .map((t) => {
      const at = events.filter((event) => Number(event.t_sec) === t);
      const speech = at
        .filter((event) => event.type === 'speech')
        .map((event) => String(event.content || '').trim())
        .filter(Boolean);
      const overlay = at
        .filter((event) => event.type === 'text_overlay')
        .map((event) => String(event.content || '').trim())
        .filter(Boolean);
      const scenes = at
        .filter((event) => event.type === 'scene_change')
        .map((event) => ({
          source: 'extract',
          sentence: String(event.content || '').trim(),
          evidence: '',
        }))
        .filter((scene) => scene.sentence);
      return {
        t_sec: t,
        speech: speech.join(' '),
        speech_score: null,
        speaker: '',
        text_on_screen: overlay.map((text) => ({ text })),
        labels: [],
        face_count: null,
        music_score: null,
        sentiment: null,
        scenes,
        outcomes: [],
        app: null,
        ask: null,
      };
    });
  return seconds;
}

export function receiptAt(seconds, timeSec) {
  if (!Array.isArray(seconds) || !seconds.length) return null;
  const t = Math.floor(Number(timeSec) || 0);
  const exact = seconds.find((row) => Math.floor(Number(row.t_sec)) === t);
  if (exact) return exact;
  let best = seconds[0];
  let bestDist = Infinity;
  for (const row of seconds) {
    const dist = Math.abs(Number(row.t_sec) - Number(timeSec || 0));
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return bestDist <= 0.6 ? best : null;
}

export function nextMark(seconds, timeSec, has) {
  if (!Array.isArray(seconds) || !seconds.length) return null;
  const now = Number(timeSec) || 0;
  const marked = seconds
    .filter((row) => has(row) && Number.isFinite(Number(row.t_sec)))
    .sort((a, b) => Number(a.t_sec) - Number(b.t_sec));
  if (!marked.length) return null;
  const ahead = marked.find((row) => Number(row.t_sec) > now + 0.04);
  if (ahead) return Number(ahead.t_sec);
  const first = Number(marked[0].t_sec);
  if (Math.abs(first - now) < 0.2) return null;
  return first;
}

export function hasAsk(row) {
  return Boolean(row?.ask && (row.ask.phrase_en || row.ask.phrase_original || row.ask.kind));
}

export function hasOutcome(row) {
  return Array.isArray(row?.outcomes) && row.outcomes.some((item) => item?.sentence);
}

export function hasApp(row) {
  return Boolean(row?.app);
}

export function receiptView(row) {
  if (!row) {
    return {
      speech: '',
      speechScore: null,
      speaker: '',
      text: [],
      labels: [],
      faceCount: null,
      musicScore: null,
      sentiment: '',
      scenes: [],
      outcomes: [],
      app: null,
      ask: null,
    };
  }
  let sentiment = '';
  if (row.sentiment && typeof row.sentiment === 'object') {
    const label = row.sentiment.label || row.sentiment.sentiment || '';
    const score = asNumber(row.sentiment.score);
    sentiment = score == null ? String(label) : `${label} ${score}`;
  } else if (row.sentiment) {
    sentiment = String(row.sentiment);
  }
  return {
    speech: String(row.speech || '').trim(),
    speechScore: asNumber(row.speech_score),
    speaker: String(row.speaker || '').trim(),
    text: (Array.isArray(row.text_on_screen) ? row.text_on_screen : textItems(row.text_on_screen).map((text) => ({ text })))
      .map((item) => {
        if (typeof item === 'string') return { text: item.trim(), score: null };
        return { text: String(item?.text || '').trim(), score: asNumber(item?.score) };
      })
      .filter((item) => item.text),
    labels: labelItems(row.labels),
    faceCount: row.face_count == null || row.face_count === '' ? null : asNumber(row.face_count),
    musicScore: row.music_score == null || row.music_score === '' ? null : asNumber(row.music_score),
    sentiment: sentiment.trim(),
    scenes: Array.isArray(row.scenes) ? row.scenes.filter((item) => item?.sentence) : [],
    outcomes: Array.isArray(row.outcomes) ? row.outcomes.filter((item) => item?.sentence) : [],
    app: row.app || null,
    ask: hasAsk(row) ? row.ask : null,
  };
}


export function sourceLabel(source) {
  if (source === 'content_understanding') return 'Content Understanding';
  if (source === 'gemini') return 'Gemini';
  if (source === 'both') return 'Both models';
  if (source === 'video_indexer') return 'Video Indexer';
  if (source === 'extract') return 'Extracted scene';
  return source || 'Record';
}
