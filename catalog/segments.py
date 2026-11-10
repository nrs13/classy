"""Chunk rows for one video: per-second lines plus multi-second segments.

Per-second chunks let a result land on an exact second. Segments merge consecutive seconds
of speech and on-screen text into windows of SEGMENT_MIN to SEGMENT_MAX seconds, cut where
a new transcript line starts, so natural-language queries have enough text to match.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SEGMENT_MIN = 6
SEGMENT_MAX = 15
CONTEXT_RADIUS = 6


@dataclass
class Chunk:
    t_sec: int
    field: str
    text: str
    confidence: float | None = None
    end_sec: int | None = None
    speaker: str = ""
    context: dict | None = None


def _clean(text) -> str:
    return " ".join(str(text or "").split())


# Content Understanding evidence prefixes each line with its segment, e.g. "00:00:02.030-00:00:06.110:".
TIME_RANGE = re.compile(r"\b\d{2}:\d{2}:\d{2}\.\d{3}-\d{2}:\d{2}:\d{2}\.\d{3}:\s*")


def strip_time_ranges(text) -> str:
    return _clean(TIME_RANGE.sub(" ", str(text or "")))


def screen_lines(row: dict) -> list[str]:
    out = []
    lines = row.get("text_on_screen") or []
    if not isinstance(lines, list):
        return out
    for item in lines:
        text = _clean(item.get("text") if isinstance(item, dict) else item)
        if text:
            out.append(text)
    return out


def speech_track(seconds: list[dict]) -> list[tuple[int, str]]:
    return [(int(row["t_sec"]), _clean(row.get("speech"))) for row in seconds if _clean(row.get("speech"))]


def context_around(track: list[tuple[int, str]], start: int, end: int, current: str = "", radius: int = CONTEXT_RADIUS):
    """Nearest different speech line before `start` and after `end`, within `radius` seconds."""
    before = ""
    for t, text in reversed(track):
        if t < start and start - t <= radius and text != current:
            before = text
            break
    after = ""
    for t, text in track:
        if t > end and t - end <= radius and text != current:
            after = text
            break
    if not before and not after:
        return None
    return {"before": before, "after": after}


def merge_overlap(previous: str, text: str) -> str:
    """The part of `text` not already said at the end of `previous` (transcript lines overlap)."""
    prev_words = previous.split()
    words = text.split()
    for k in range(min(len(prev_words), len(words)), 0, -1):
        if prev_words[-k:] == words[:k]:
            return " ".join(words[k:])
    return text


@dataclass
class _Window:
    start: int
    end: int
    speech: list[str] = field(default_factory=list)
    screen: list[str] = field(default_factory=list)
    speakers: set = field(default_factory=set)
    last_speech: str = ""

    def add_speech(self, text: str) -> None:
        if not text:
            return
        if not self.speech:
            self.speech.append(text)
            return
        if text in " ".join(self.speech):
            return
        last = self.speech[-1]
        if last in text:
            self.speech[-1] = text
            return
        self.speech.append(merge_overlap(last, text))

    def add_screen(self, lines: list[str]) -> None:
        for line in lines:
            if line not in self.screen:
                self.screen.append(line)

    def text(self) -> str:
        parts = []
        if self.speech:
            parts.append(" ".join(self.speech))
        if self.screen:
            parts.append(" / ".join(self.screen))
        return " / ".join(parts)


def build_segments(seconds: list[dict], track: list[tuple[int, str]] | None = None) -> list[Chunk]:
    rows = sorted(seconds, key=lambda row: int(row["t_sec"]))
    track = speech_track(rows) if track is None else track
    windows: list[_Window] = []
    current: _Window | None = None
    for row in rows:
        t = int(row["t_sec"])
        speech = _clean(row.get("speech"))
        lines = screen_lines(row)
        if not speech and not lines:
            if current and t - current.start >= SEGMENT_MIN:
                windows.append(current)
                current = None
            continue
        if current is not None:
            span = t - current.start
            new_line = bool(speech) and speech != current.last_speech
            if span >= SEGMENT_MAX or (span >= SEGMENT_MIN and new_line) or t - current.end > 2:
                windows.append(current)
                current = None
        if current is None:
            current = _Window(start=t, end=t)
        current.add_speech(speech)
        current.add_screen(lines)
        if speech:
            current.last_speech = speech
            speaker = _clean(row.get("speaker"))
            if speaker:
                current.speakers.add(speaker)
        current.end = t
    if current is not None:
        windows.append(current)
    out = []
    for window in windows:
        text = window.text()
        if not text or (out and text in out[-1].text):
            continue
        out.append(
            Chunk(
                t_sec=window.start,
                end_sec=window.end + 1,
                field="segment",
                text=text,
                speaker=next(iter(window.speakers)) if len(window.speakers) == 1 else "",
                context=context_around(track, window.start, window.end),
            )
        )
    return out


VIDEO_DOC_MAX = 4000
VIDEO_DOC_SPEECH = 800


def video_document(seconds: list[dict], topics: list[str], max_chars: int = VIDEO_DOC_MAX) -> Chunk | None:
    """One text for the whole video, so a description of what a video is about can match it.

    Topics and the opening speech come first (they are short); distinct scene sentences in
    time order fill the rest, cut at `max_chars` code points.
    """
    rows = sorted(seconds, key=lambda row: int(row["t_sec"]))
    speech = ""
    for _t, line in speech_track(rows):
        addition = merge_overlap(speech, line) if speech else line
        if not addition or addition in speech:
            continue
        speech = f"{speech} {addition}".strip()
        if len(speech) >= VIDEO_DOC_SPEECH:
            speech = speech[:VIDEO_DOC_SPEECH]
            break
    scenes, seen = [], set()
    for row in rows:
        for scene in row.get("scenes") or []:
            sentence = _clean(scene.get("sentence"))
            if sentence and sentence.lower() not in seen:
                seen.add(sentence.lower())
                scenes.append(sentence)
    parts = []
    names = [name for name in topics if str(name).strip()]
    if names:
        parts.append("Topics: " + ", ".join(names) + ".")
    if speech:
        parts.append("Said: " + speech)
    if scenes:
        parts.append(" ".join(scenes))
    text = "\n".join(parts)[:max_chars].strip()
    if not text:
        return None
    end = int(rows[-1]["t_sec"]) + 1 if rows else None
    return Chunk(t_sec=0, end_sec=end, field="video", text=text)


def chunks_for(seconds: list[dict], tags: dict[str, list[str]], networks: str, normalize_score) -> list[Chunk]:
    """Every chunk for one video. `tags` maps a field (topic, keyword) to its names."""
    rows: list[Chunk] = []
    track = speech_track(seconds)

    def add(t_sec, field_name, text, confidence=None, speaker="", current=""):
        cleaned = str(text or "").strip()
        if not cleaned:
            return
        rows.append(
            Chunk(
                t_sec=int(t_sec),
                field=field_name,
                text=cleaned,
                confidence=normalize_score(confidence),
                speaker=speaker,
                context=context_around(track, int(t_sec), int(t_sec), current or cleaned),
            )
        )

    for row in seconds:
        t = row["t_sec"]
        speech = _clean(row.get("speech"))
        add(t, "speech", row.get("speech"), row.get("speech_score"), _clean(row.get("speaker")), speech)
        lines = row.get("text_on_screen") or []
        if isinstance(lines, list):
            for item in lines:
                if isinstance(item, dict):
                    add(t, "text_on_screen", item.get("text"), item.get("score"), current=speech)
                else:
                    add(t, "text_on_screen", item, None, current=speech)
        for scene in row.get("scenes") or []:
            add(t, "scene", scene.get("sentence"), current=speech)
            add(t, "evidence", strip_time_ranges(scene.get("evidence")), current=speech)
        ask = row.get("ask") or {}
        if ask:
            add(
                t,
                "ask",
                " ".join(part for part in (ask.get("phrase_original"), ask.get("phrase_en")) if part),
                current=speech,
            )
    for field_name, names in tags.items():
        joined = " ".join(name for name in names if str(name).strip())
        if joined.strip():
            rows.append(Chunk(t_sec=0, field=field_name, text=joined.strip()))
    if networks:
        rows.append(Chunk(t_sec=0, field="activation", text=networks))
    rows.extend(build_segments(seconds, track))
    whole = video_document(seconds, tags.get("topic", []))
    if whole:
        rows.append(whole)
    return rows
