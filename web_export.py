#!/usr/bin/env python3
"""Pack TRIBE outputs into web/public/data (mesh, act bins, manifest, knowledge)."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np

N_VERTICES = 20484  # fsaverage5 both hemispheres (TRIBE V2)
MAX_FRAMES = 90
HOOK_SEC = 3.0


def load_fsaverage5_mesh():
    """Return (positions float32[N,3], faces uint32[M,3])."""
    try:
        from nilearn import datasets, surface

        fsa = datasets.fetch_surf_fsaverage(mesh="fsaverage5")
        l_pos, l_faces = surface.load_surf_mesh(fsa["pial_left"])
        r_pos, r_faces = surface.load_surf_mesh(fsa["pial_right"])
        positions = np.vstack([l_pos, r_pos]).astype(np.float32)
        faces = np.vstack([l_faces, r_faces + len(l_pos)]).astype(np.uint32)
        return positions, faces, len(l_pos)
    except Exception as e_nilearn:
        try:
            import nibabel as nib
            from nilearn import datasets

            fsa = datasets.fetch_surf_fsaverage(mesh="fsaverage5")
            # FreeSurfer geometry files
            l = nib.freesurfer.read_geometry(fsa["pial_left"])
            r = nib.freesurfer.read_geometry(fsa["pial_right"])
            positions = np.vstack([l[0], r[0]]).astype(np.float32)
            faces = np.vstack([l[1], r[1] + len(l[0])]).astype(np.uint32)
            return positions, faces, len(l[0])
        except Exception as e_nib:
            raise RuntimeError(
                "Need nilearn (or nibabel+nilearn) to export fsaverage5 mesh. "
                f"nilearn={e_nilearn}; nibabel={e_nib}"
            )


def tier_for(plays: int | None) -> str:
    if plays is None:
        return "unknown"
    if plays >= 1_000_000:
        return "breakout"
    if plays >= 50_000:
        return "strong"
    if plays >= 10_000:
        return "mid"
    return "tail"


def _num(x):
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    try:
        return int(s) if "." not in s else float(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return None


def read_metadata(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, newline="") as f:
        return {r["video_id"]: r for r in csv.DictReader(f)}


def neural_features(act: np.ndarray, timestamps: np.ndarray | None) -> dict:
    """act: (V, T) float. Features on mean |activation| over vertices."""
    abs_act = np.abs(act)
    mean_t = abs_act.mean(axis=0)  # (T,)
    peak = float(mean_t.max()) if mean_t.size else 0.0
    mean_abs = float(abs_act.mean()) if abs_act.size else 0.0

    if timestamps is None or timestamps.size != mean_t.size:
        timestamps = np.arange(mean_t.size, dtype=np.float32)

    # Hook slope: linear fit of mean |act| over first HOOK_SEC seconds.
    hook_mask = timestamps <= HOOK_SEC
    if hook_mask.sum() >= 2:
        x = timestamps[hook_mask]
        y = mean_t[hook_mask]
        slope = float(np.polyfit(x, y, 1)[0])
    else:
        slope = float(mean_t[-1] - mean_t[0]) if mean_t.size >= 2 else 0.0

    # Sustain: fraction of frames ≥ 50% of peak after the hook window.
    after = ~hook_mask if hook_mask.any() else np.ones_like(mean_t, dtype=bool)
    if after.any() and peak > 0:
        sustain = float((mean_t[after] >= 0.5 * peak).mean())
    else:
        sustain = 0.0

    return {
        "hook_slope": round(slope, 6),
        "mean_abs_activation": round(mean_abs, 6),
        "peak_mean_abs": round(peak, 6),
        "sustain_ratio": round(sustain, 4),
        "time_steps": int(mean_t.size),
        "duration_sec": float(timestamps[-1]) if timestamps.size else 0.0,
    }


def quantize_activation(act: np.ndarray, max_frames: int) -> tuple[np.ndarray, int]:
    """act (V, T) → uint8 flat (frames * V), abs-normalized per video."""
    abs_act = np.abs(act.astype(np.float32))
    t = abs_act.shape[1]
    if t > max_frames:
        idx = np.linspace(0, t - 1, max_frames).astype(np.int32)
        abs_act = abs_act[:, idx]
        t = max_frames
    peak = float(abs_act.max()) or 1.0
    norm = np.clip(abs_act / peak, 0, 1)
    u8 = (norm * 255).astype(np.uint8)
    # web expects frames-major: (T, V)
    return u8.T.reshape(-1), t


def export(outputs: Path, metadata_csv: Path, out: Path, max_frames: int = MAX_FRAMES):
    out.mkdir(parents=True, exist_ok=True)
    act_dir = out / "act"
    act_dir.mkdir(exist_ok=True)

    print("Loading fsaverage5 mesh…", flush=True)
    positions, faces, hemi_split = load_fsaverage5_mesh()
    if positions.shape[0] != N_VERTICES:
        print(f"warn: expected {N_VERTICES} verts, got {positions.shape[0]}", flush=True)

    (out / "brain_pos.bin").write_bytes(positions.astype(np.float32).tobytes())
    (out / "brain_idx.bin").write_bytes(faces.astype(np.uint32).ravel().tobytes())

    meta_rows = read_metadata(metadata_csv)
    vid_dirs = sorted(
        [p for p in outputs.iterdir() if p.is_dir() and (p / "activation.npy").exists()]
    )
    if not vid_dirs:
        raise SystemExit(f"No activation.npy under {outputs}")

    videos = []
    knowledge_videos = []

    for vd in vid_dirs:
        vid = vd.name
        act = np.load(vd / "activation.npy")
        if act.ndim != 2:
            raise RuntimeError(f"{vid}: activation shape {act.shape}")
        # Accept (V,T) or (T,V)
        if act.shape[0] != positions.shape[0] and act.shape[1] == positions.shape[0]:
            act = act.T
        if act.shape[0] != positions.shape[0]:
            raise RuntimeError(
                f"{vid}: expected {positions.shape[0]} verts, got {act.shape}"
            )

        ts_path = vd / "timestamps.npy"
        timestamps = np.load(ts_path) if ts_path.exists() else None
        meta_json = {}
        mj = vd / "meta.json"
        if mj.exists():
            meta_json = json.loads(mj.read_text())

        row = meta_rows.get(vid, {})
        plays = _num(row.get("plays") or (meta_json.get("metrics") or {}).get("plays"))
        likes = _num(row.get("likes") or (meta_json.get("metrics") or {}).get("likes"))
        comments = _num(
            row.get("comments") or (meta_json.get("metrics") or {}).get("comments")
        )
        followers = _num(
            row.get("followers") or meta_json.get("followers")
        )
        duration = _num(row.get("duration_sec") or meta_json.get("video_duration_sec"))

        like_rate = round(likes / plays, 6) if likes is not None and plays else None
        amplification = (
            round(plays / followers, 4) if plays is not None and followers else None
        )

        feats = neural_features(act, timestamps)
        u8, frames = quantize_activation(act, max_frames)
        (act_dir / f"{vid}.bin").write_bytes(u8.tobytes())

        annotations = {
            "format": row.get("format")
            or (meta_json.get("annotations") or {}).get("format", ""),
            "key_elements": row.get("key_elements")
            or (meta_json.get("annotations") or {}).get("key_elements", ""),
            "relatability_hook": row.get("relatability_hook")
            or (meta_json.get("annotations") or {}).get("relatability_hook", ""),
        }

        entry = {
            "id": vid,
            "account": row.get("account") or meta_json.get("account", ""),
            "tier": tier_for(int(plays) if plays is not None else None),
            "group": vid[0] if vid else "",
            "video": f"videos/{vid}.mp4",
            "duration": duration or feats["duration_sec"],
            "frames": frames,
            "metrics": {
                "plays": plays,
                "likes": likes,
                "comments": comments,
                "followers": followers,
                "like_rate": like_rate,
                "amplification": amplification,
            },
            "annotations": annotations,
            "features": feats,
        }
        videos.append(entry)
        knowledge_videos.append(
            {
                **entry,
                "url": row.get("url") or meta_json.get("url", ""),
                "posted_at": row.get("posted_at") or meta_json.get("posted_at", ""),
                "source_meta": {
                    k: meta_json.get(k)
                    for k in ("model_id", "device", "vertices", "time_steps")
                    if k in meta_json
                },
            }
        )
        print(f"{vid}: frames={frames} peak={feats['peak_mean_abs']:.4f}", flush=True)

    # Rank by plays for compare defaults
    videos.sort(key=lambda v: (v["metrics"]["plays"] or 0), reverse=True)
    knowledge_videos.sort(key=lambda v: (v["metrics"]["plays"] or 0), reverse=True)

    manifest = {
        "product": "Classy",
        "tagline": "marketing reimagined",
        "n": len(videos),
        "vertexCount": int(positions.shape[0]),
        "hemiSplit": int(hemi_split),
        "activationEncoding": "uint8 abs-normalized per video, frame-major (T*V)",
        "videos": videos,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))

    knowledge = {
        "product": "Classy",
        "tagline": "marketing reimagined",
        "scope": "N=10 Instagram study-niche reels; TRIBE V2 predicted cortical response.",
        "caveats": [
            "N=10 — exploratory only; do not claim statistical significance.",
            "TRIBE predicts group-average encoding responses, not individual brains.",
            "Hemodynamic lag: peaks are delayed relative to stimulus events.",
            "Activation shown is |response| abs-normalized per video for viz.",
        ],
        "formulas": {
            "like_rate": {
                "expr": "likes / plays",
                "notes": "Engagement intensity conditional on reach.",
            },
            "amplification": {
                "expr": "plays / followers",
                "notes": "Reach relative to account size; breakouts >> 1.",
            },
            "hook_slope": {
                "expr": f"slope of mean_|act|(t) for t ≤ {HOOK_SEC}s",
                "notes": "Positive = rising early response; proxy for hook strength.",
            },
            "mean_abs_activation": {
                "expr": "mean(|activation| over vertices and time)",
                "notes": "Overall response magnitude.",
            },
            "peak_mean_abs": {
                "expr": "max_t mean_v |activation(v,t)|",
                "notes": "Strongest whole-cortex moment.",
            },
            "sustain_ratio": {
                "expr": "fraction of post-hook frames with mean_|act| ≥ 0.5 * peak",
                "notes": "How long activation stays elevated after the open.",
            },
        },
        "mesh": {
            "surface": "fsaverage5 pial (nilearn)",
            "vertices": int(positions.shape[0]),
            "hemiSplit": int(hemi_split),
            "files": ["brain_pos.bin", "brain_idx.bin"],
        },
        "videos": knowledge_videos,
    }
    (out / "knowledge.json").write_text(json.dumps(knowledge, indent=2))

    print(
        f"Wrote {len(videos)} videos → {out}/manifest.json, knowledge.json, "
        f"brain_*.bin, act/*.bin",
        flush=True,
    )


def main():
    root = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="Export Classy web data pack")
    p.add_argument("--outputs", type=Path, default=root / "outputs")
    p.add_argument("--metadata", type=Path, default=root / "metadata.csv")
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--max-frames", type=int, default=MAX_FRAMES)
    args = p.parse_args()
    export(args.outputs, args.metadata, args.out, max_frames=args.max_frames)


if __name__ == "__main__":
    main()
