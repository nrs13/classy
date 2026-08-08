#!/usr/bin/env python3
"""Pack Classy TRIBE outputs and metadata into Download Data.zip on Google Drive."""

from __future__ import annotations

import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

DRIVE_ROOT = Path("/content/drive/MyDrive")
SIDE_WORK = DRIVE_ROOT / "Side_Work"
DEST = SIDE_WORK / "Download Data"
ZIP_PATH = SIDE_WORK / "Download Data.zip"
SRC_OUTPUTS = SIDE_WORK / "outputs"
SRC_META = SIDE_WORK / "metadata.csv"
SRC_EXPORT = SIDE_WORK / "web_export.py"

# Fallback rows matching Classy metadata.csv when Drive copy is missing.
EMBEDDED_METADATA_CSV = """video_id,account,followers,shortcode,url,posted_at,captured_at,duration_sec,plays,views,likes,comments,format,key_elements,relatability_hook
A_V1,rosestudydiary,12900,DbZCI8dvr3Q,https://www.instagram.com/reel/DbZCI8dvr3Q/,2026-07-29,2026-08-06,73.1,378305,247593,30504,277,"Creative demonstration + advise","No background audio, includes a physical or tactile prop/component","Student coded styling (outfit, setting) and dialogue"
A_V2,rosestudydiary,12900,DbgmwZHPtka,https://www.instagram.com/reel/DbgmwZHPtka/,2026-08-01,2026-08-06,84.451,2675,853,32,2,"Product demo","Authentic on camera reactions paired with an on screen response from Knowie (Knowunity's AI chat feature), minimal or plain background","Student coded styling (outfit)"
A_V3,rosestudydiary,12900,Dak5bN_x3QN,https://www.instagram.com/reel/Dak5bN_x3QN/,2026-07-09,2026-08-06,44.422,20328,297,438,23,"Product demo","Genuine on camera reaction shots synced to an on screen response from Knowie (Knowunity's AI chat feature), minimal or plain background","Student coded styling (outfit)"
A_V4,rosestudydiary,12900,DaNZKo6h8Yf,https://www.instagram.com/reel/DaNZKo6h8Yf/,2026-06-30,2026-08-06,27.236,12102,828,83,0,"Product demo","Genuine on camera reaction shots synced to an on screen response from Knowie (Knowunity's AI chat feature), minimal or plain background","Student coded styling (outfit)"
A_V5,rosestudydiary,12900,DbO9qcZvcpI,https://www.instagram.com/reel/DbO9qcZvcpI/,2026-07-26,2026-08-06,85.733,94913,38142,5442,79,"advice / talking head","Filmed in car setting, phone or clutch propped in the sun visor, casual at home style clothing rather than styled or dressed up","Everyday, unpolished relatability (setting andwardrobe)"
B_V1,thelilystudylog,915,DWNY1iIDJ8o,https://www.instagram.com/reel/DWNY1iIDJ8o/,2026-03-23,2026-08-06,7.166,6546346,2336499,415566,363,"Reaction, head on camera","Mild shocked or frustrated reaction, low intensity facial expression, background music is a rap verse, plain background","Minimal, framed as a senior to junior exchange but the situation still reads as something a junior would face"
B_V2,thelilystudylog,915,DX3JsmWsTfE,https://www.instagram.com/reel/DX3JsmWsTfE/,,2026-08-06,8,1980,,26,0,"Reaction plus product demo","Mild shocked reaction, unclear whether background audio is present","Student diaspora experience with parents"
B_V3,thelilystudylog,915,DXx2_z6s0Oy,https://www.instagram.com/reel/DXx2_z6s0Oy/,2026-05-01,2026-08-06,8.055,1717,864,13,0,"Reaction plus product demo","Mild shocked reaction, unclear whether background audio is present","Not specified"
B_V4,thelilystudylog,915,DXAycihjO7P,https://www.instagram.com/reel/DXAycihjO7P/,2026-04-12,2026-08-06,11.266,2627,1302,23,0,"Reaction plus product demo","Mild shocked reaction, unclear whether background audio is present","Student diaspora experience with parents"
B_V5,thelilystudylog,915,DXYIe-_DKuX,https://www.instagram.com/reel/DXYIe-_DKuX/,2026-04-21,2026-08-06,7.2,10211,4060,74,1,"Reaction, head on camera","Mild shocked or frustrated reaction, has sound, background appears to be a room but isn't clearly defined, presented as an opinion style video with captions overlaid","Not specified"
"""

NEEDED_FILES = ("activation.npy", "timestamps.npy", "meta.json")


def mount_drive() -> None:
    from google.colab import drive  # type: ignore

    drive.mount("/content/drive")


def ensure_metadata(dest_meta: Path) -> str:
    if SRC_META.exists():
        shutil.copy2(SRC_META, dest_meta)
        return f"copied from {SRC_META}"
    dest_meta.write_text(EMBEDDED_METADATA_CSV)
    return "wrote embedded Classy metadata.csv"


def copy_outputs(dest_outputs: Path) -> list[dict]:
    dest_outputs.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    if not SRC_OUTPUTS.is_dir():
        print(f"warn: missing outputs at {SRC_OUTPUTS}")
        return rows

    for vd in sorted(p for p in SRC_OUTPUTS.iterdir() if p.is_dir()):
        act = vd / "activation.npy"
        if not act.exists():
            continue
        out_vd = dest_outputs / vd.name
        out_vd.mkdir(parents=True, exist_ok=True)
        present = {}
        for name in NEEDED_FILES:
            src = vd / name
            if src.exists():
                shutil.copy2(src, out_vd / name)
                present[name] = src.stat().st_size
            else:
                present[name] = None
        rows.append({"video_id": vd.name, "files": present})
    return rows


def copy_web_export(dest: Path) -> str:
    dest_script = dest / "web_export.py"
    if SRC_EXPORT.exists():
        shutil.copy2(SRC_EXPORT, dest_script)
        return f"copied from {SRC_EXPORT}"
    dest_script.write_text("# Classy web_export.py missing on Drive.\n")
    return "warn: web_export.py missing"


def try_web_export(dest_meta: Path, dest_outputs: Path, export_out: Path) -> tuple[bool, str]:
    try:
        import subprocess

        print("Installing nilearn, nibabel, numpy…", flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "nilearn", "nibabel", "numpy"],
        )
    except Exception as e:
        return False, f"pip install failed: {e}"

    export_script = DEST / "web_export.py"
    if not export_script.exists() or export_script.stat().st_size < 200:
        export_script = SRC_EXPORT
    if not export_script.exists():
        return False, "web_export.py not found"

    if not any(dest_outputs.glob("*/activation.npy")):
        return False, "no activation.npy in packed outputs"

    export_out.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(export_script),
        "--outputs",
        str(dest_outputs),
        "--metadata",
        str(dest_meta),
        "--out",
        str(export_out),
    ]
    print("Running Classy web_export.py →", export_out, flush=True)
    try:
        import subprocess

        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout or "export failed")[-2000:]
            return False, f"web_export exit {r.returncode}: {msg}"
        if r.stdout:
            print(r.stdout[-1500:], flush=True)
        return True, "export OK"
    except Exception as e:
        return False, f"web_export exception: {e}"


def zip_folder(folder: Path, zip_path: Path) -> int:
    if zip_path.exists():
        zip_path.unlink()
    n = 0
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                zf.write(f, arcname=str(Path("Download Data") / f.relative_to(folder)))
                n += 1
    return n


def format_bytes(n: int | float | None) -> str:
    if n is None:
        return "MISSING"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


def write_inventory(
    dest: Path,
    video_rows: list[dict],
    meta_note: str,
    export_note: str,
    export_ok: bool,
    zip_bytes: int,
) -> Path:
    lines = [
        "Classy Download Data inventory",
        f"packed_at_utc: {datetime.now(timezone.utc).isoformat()}",
        f"dest: {dest}",
        f"zip: {ZIP_PATH} ({format_bytes(zip_bytes)})",
        "",
        f"metadata.csv: {meta_note}",
        f"web_export: {(DEST / 'web_export.py').exists()}",
        f"web_public_data: {'OK: ' + export_note if export_ok else 'FAILED: ' + export_note}",
        "",
        f"videos with activation.npy: {len(video_rows)}",
    ]
    for row in video_rows:
        parts = []
        for name in NEEDED_FILES:
            sz = row["files"].get(name)
            parts.append(f"{name}={format_bytes(sz)}" if sz else f"{name}=MISSING")
        lines.append(f"  {row['video_id']}: " + ", ".join(parts))

    export_dir = dest / "web_public_data"
    if export_dir.is_dir():
        lines.append("")
        lines.append("web_public_data/")
        for f in sorted(export_dir.rglob("*")):
            if f.is_file():
                rel = f.relative_to(export_dir)
                lines.append(f"  {rel}: {format_bytes(f.stat().st_size)}")

    inv = dest / "INVENTORY.txt"
    inv.write_text("\n".join(lines) + "\n")
    return inv


def main() -> None:
    print("Classy packer: Drive/Side_Work/Download Data")

    if not Path("/content/drive/MyDrive").exists():
        print("Mounting Google Drive…")
        mount_drive()
    else:
        print("Drive already mounted.")

    if not SIDE_WORK.is_dir():
        raise SystemExit(f"Classy Side_Work not found at {SIDE_WORK}")

    if DEST.exists():
        print(f"Removing previous {DEST}")
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)

    dest_meta = DEST / "metadata.csv"
    meta_note = ensure_metadata(dest_meta)
    print(f"metadata.csv: {meta_note}")

    dest_outputs = DEST / "outputs"
    video_rows = copy_outputs(dest_outputs)
    print(f"Packed {len(video_rows)} video output dirs")

    export_copy_note = copy_web_export(DEST)
    print(f"web_export.py: {export_copy_note}")

    export_out = DEST / "web_public_data"
    export_ok, export_note = try_web_export(dest_meta, dest_outputs, export_out)
    print(f"web_public_data: {export_note}")

    zip_folder(DEST, ZIP_PATH)
    zip_bytes = ZIP_PATH.stat().st_size if ZIP_PATH.exists() else 0
    inv = write_inventory(DEST, video_rows, meta_note, export_note, export_ok, zip_bytes)
    n_files = zip_folder(DEST, ZIP_PATH)
    zip_bytes = ZIP_PATH.stat().st_size

    print()
    print(inv.read_text())
    print(f"Done. Folder: {DEST}")
    print(f"ZIP: {ZIP_PATH} ({format_bytes(zip_bytes)}, {n_files} files)")


if __name__ == "__main__":
    main()
