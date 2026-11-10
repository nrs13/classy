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
YEO7_NAMES = {
    1: "Visual",
    2: "Somatomotor",
    3: "Dorsal Attention",
    4: "Ventral Attention",
    5: "Limbic",
    6: "Frontoparietal",
    7: "Default Mode Network",
}


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


def load_yeo7_labels(atlas_dir: Path, hemi_split: int) -> np.ndarray:
    """Load uint8 Yeo-7 labels in left-then-right fsaverage5 vertex order."""
    import nibabel as nib

    hemispheres = []
    for hemi in ("lh", "rh"):
        path = atlas_dir / f"{hemi}.Yeo2011_7Networks_N1000.annot"
        if not path.exists():
            raise RuntimeError(f"Missing official Yeo-7 annotation: {path}")
        labels, _, names_raw = nib.freesurfer.read_annot(path)
        if labels.shape != (hemi_split,):
            raise RuntimeError(
                f"{path.name}: expected {hemi_split} labels, got {labels.shape}"
            )
        if np.any(labels < 0):
            raise RuntimeError(f"{path.name}: contains unmapped annotation labels")

        names = [name.decode("utf-8") for name in names_raw]
        expected = ["FreeSurfer_Defined_Medial_Wall"] + [
            f"7Networks_{i}" for i in range(1, 8)
        ]
        if names != expected:
            raise RuntimeError(f"{path.name}: unexpected label table {names}")

        canonical = np.zeros(labels.shape, dtype=np.uint8)
        for annotation_id, name in enumerate(names):
            if annotation_id == 0:
                continue
            network_id = int(name.rsplit("_", 1)[1])
            canonical[labels == annotation_id] = network_id
        hemispheres.append(canonical)

    combined = np.concatenate(hemispheres)
    if combined.shape != (N_VERTICES,):
        raise RuntimeError(
            f"Yeo-7: expected {N_VERTICES} combined labels, got {combined.shape}"
        )
    if set(np.unique(combined)) != set(range(8)):
        raise RuntimeError("Yeo-7: expected medial wall 0 and network labels 1 through 7")
    return combined


def network_features(
    act: np.ndarray,
    timestamps: np.ndarray | None,
    labels: np.ndarray,
) -> dict:
    """Summarize predicted activation by coarse Yeo-7 cortical network."""
    if act.shape[0] != labels.size:
        raise RuntimeError(
            f"Activation vertices {act.shape[0]} do not match atlas {labels.size}"
        )
    if timestamps is None or timestamps.size != act.shape[1]:
        timestamps = np.arange(act.shape[1], dtype=np.float32)

    abs_act = np.abs(act)
    means = {}
    peak_t_sec = {}
    for network_id, name in YEO7_NAMES.items():
        mask = labels == network_id
        if not mask.any():
            raise RuntimeError(f"Yeo-7 network has no vertices: {name}")
        mean_t = abs_act[mask].mean(axis=0)
        means[name] = round(float(mean_t.mean()), 6)
        peak_index = int(mean_t.argmax()) if mean_t.size else 0
        peak_t_sec[name] = (
            round(float(timestamps[peak_index]), 3) if mean_t.size else 0.0
        )

    top = sorted(means, key=means.get, reverse=True)[:3]
    return {
        "atlas": "Yeo-7",
        "scope": "cortical parcellation",
        "medial_wall_excluded": True,
        "means": means,
        "top": top,
        "peak_t_sec": peak_t_sec,
    }


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

    peak_i = int(mean_t.argmax()) if mean_t.size else 0
    timeline = {
        "description": (
            "Per-frame mean cortical |activation| from TRIBE "
            "(same series underlying the Explore timeline chart). "
            "Not ROI/region-specific."
        ),
        "n_frames": int(mean_t.size),
        "peak_frame_index": peak_i,
        "peak_t_sec": round(float(timestamps[peak_i]), 3) if timestamps.size else 0.0,
        "peak_mean_abs": round(float(mean_t[peak_i]), 6) if mean_t.size else 0.0,
        "series": [
            {
                "t_sec": round(float(timestamps[i]), 3),
                "mean_abs": round(float(mean_t[i]), 6),
            }
            for i in range(int(mean_t.size))
        ],
    }

    return {
        "hook_slope": round(slope, 6),
        "mean_abs_activation": round(mean_abs, 6),
        "peak_mean_abs": round(peak, 6),
        "sustain_ratio": round(sustain, 4),
        "time_steps": int(mean_t.size),
        "duration_sec": float(timestamps[-1]) if timestamps.size else 0.0,
        "activation_timeline": timeline,
    }


def build_story(timeline: dict, content_events: list[dict]) -> list[dict]:
    series = timeline.get("series", [])
    story = [
        {
            "t_sec": point["t_sec"],
            "activation": point["mean_abs"],
            "events": [],
        }
        for point in series
    ]
    if not story:
        return story

    grid = np.asarray([point["t_sec"] for point in story], dtype=np.float64)
    for event in content_events:
        if not isinstance(event, dict) or "t_sec" not in event:
            raise RuntimeError("Each content event must be an object with t_sec")
        event_time = float(event["t_sec"])
        index = int(np.abs(grid - event_time).argmin())
        story[index]["events"].append(
            {key: value for key, value in event.items() if key != "t_sec"}
        )
    return story


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


def export(
    outputs: Path,
    metadata_csv: Path,
    out: Path,
    atlas_dir: Path,
    max_frames: int = MAX_FRAMES,
):
    out.mkdir(parents=True, exist_ok=True)
    act_dir = out / "act"
    act_dir.mkdir(exist_ok=True)

    print("Loading fsaverage5 mesh…", flush=True)
    positions, faces, hemi_split = load_fsaverage5_mesh()
    if positions.shape[0] != N_VERTICES:
        print(f"warn: expected {N_VERTICES} verts, got {positions.shape[0]}", flush=True)

    atlas_labels = load_yeo7_labels(atlas_dir, hemi_split)
    (out / "brain_pos.bin").write_bytes(positions.astype(np.float32).tobytes())
    (out / "brain_idx.bin").write_bytes(faces.astype(np.uint32).ravel().tobytes())
    (out / "atlas_yeo7_labels.bin").write_bytes(atlas_labels.tobytes())

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
        timeline = feats.pop("activation_timeline")
        networks = network_features(act, timestamps, atlas_labels)
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

        content_events_path = vd / "content_events.json"
        content_events = (
            json.loads(content_events_path.read_text())
            if content_events_path.exists()
            else []
        )
        if not isinstance(content_events, list):
            raise RuntimeError(f"{vid}: content_events.json must contain a list")
        story = build_story(timeline, content_events)

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
                "activation_timeline": timeline,
                "content_events": content_events,
                "story": story,
                "networks": networks,
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
        "n": len(videos),
        "vertexCount": int(positions.shape[0]),
        "hemiSplit": int(hemi_split),
        "activationEncoding": "uint8 abs-normalized per video, frame-major (T*V)",
        "atlas": {
            "name": "Yeo-7",
            "scope": "coarse 7-network cortical parcellation",
            "labels": "atlas_yeo7_labels.bin",
            "encoding": "uint8; 0=medial wall, 1-7=network id",
            "vertexCount": int(atlas_labels.size),
            "hemiSplit": int(hemi_split),
            "networkNames": {str(k): v for k, v in YEO7_NAMES.items()},
            "medialWall": {
                "label": 0,
                "vertexCount": int((atlas_labels == 0).sum()),
                "excludedFromNetworkMeans": True,
            },
            "requiresRealMesh": True,
            "syntheticMeshCompatible": False,
        },
        "videos": videos,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))

    knowledge = {
        "product": "Classy",
        "scope": f"N={len(videos)} Instagram study-niche reels; TRIBE V2 predicted cortical response.",
        "caveats": [
            f"N={len(videos)}. Exploratory only; do not claim statistical significance.",
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
                "notes": "Strongest mean cortical activation moment.",
            },
            "sustain_ratio": {
                "expr": "fraction of post-hook frames with mean_|act| ≥ 0.5 * peak",
                "notes": "How long activation stays elevated after the open.",
            },
            "activation_timeline": {
                "expr": "for each frame t: mean over vertices of |activation(v,t)|",
                "notes": (
                    "Whole-cortex time series used by the Explore activation timeline. "
                    "No per-region/ROI breakdown is available."
                ),
            },
        },
        "mesh": {
            "surface": "fsaverage5 pial (nilearn)",
            "vertices": int(positions.shape[0]),
            "hemiSplit": int(hemi_split),
            "files": ["brain_pos.bin", "brain_idx.bin"],
        },
        "atlas": {
            "name": "Yeo-7",
            "scope": "coarse 7-network cortical parcellation",
            "source": "Thomas Yeo Lab CBIG fsaverage5 annotations",
            "labels": "atlas_yeo7_labels.bin",
            "encoding": "uint8; 0=medial wall, 1-7=network id",
            "networkNames": {str(k): v for k, v in YEO7_NAMES.items()},
            "medialWall": {
                "label": 0,
                "vertexCount": int((atlas_labels == 0).sum()),
                "excludedFromNetworkMeans": True,
            },
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
    p.add_argument("--yeo-atlas", type=Path, default=root / "reference" / "yeo2011")
    p.add_argument("--max-frames", type=int, default=MAX_FRAMES)
    args = p.parse_args()
    export(
        args.outputs,
        args.metadata,
        args.out,
        args.yeo_atlas,
        max_frames=args.max_frames,
    )


if __name__ == "__main__":
    main()
