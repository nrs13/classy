# Classy

**marketing reimagined**

Watch a reel next to its predicted brain response (Meta TRIBE V2), compare breakouts vs tails, and ask Classy about the numbers. Built as a small internal POC on 10 Instagram study-niche reels.

Live demo: [classy-poc-260807.web.app](https://classy-poc-260807.web.app)

## Stack

| Layer | What |
|-------|------|
| App | React + Vite + Tailwind + react-three-fiber |
| Brain | TRIBE V2 activations on fsaverage5 |
| Chat | Firebase AI Logic (Gemini), grounded on `knowledge.json` |

## Repo layout

```
metadata.csv          engagement + annotations
extract.py            TRIBE inference → outputs/
web_export.py         pack mesh + activations for the web app
colab_pack_download_data.py   Colab helper to zip Drive outputs
web/                  frontend
  public/data/        brain bins, act/, videos/, manifest, knowledge
```

## Quick start (web)

```bash
cd web
cp .env.example .env   # add Firebase web app keys
npm install
npm run dev
```

Open the local URL. Explore one reel, Compare up to four, or open Ask Classy.

### Deploy

```bash
cd web
npm run build
npx firebase-tools@latest deploy --only hosting
```

## Data pipeline

1. Put MP4s in `videos/` as `A_V1.mp4` … `B_V5.mp4`.
2. Run TRIBE (Colab A100 is fine):

```bash
pip install -r requirements.txt
python extract.py
```

3. Export for the app:

```bash
pip install nilearn nibabel numpy
python web_export.py --out web/public/data
```

Copy MP4s into `web/public/data/videos/` if they are not there already.

## Neural features

| Feature | Meaning |
|---------|---------|
| `like_rate` | likes / plays |
| `amplification` | plays / followers |
| `hook_slope` | early rise in mean \|activation\| (first ~3s) |
| `peak_mean_abs` | peak cortical engagement over time |
| `sustain_ratio` | share of post-hook frames that stay ≥ half peak |

N=10. Descriptive only, not statistical proof.

## Notes

- Ask Classy free-tier Gemini quota is limited (~20 sends/day/model).
- Keep Firebase keys in `web/.env` (gitignored). Never commit `.env`.
- Raw `outputs/` and root `videos/` are gitignored; the app ships with `web/public/data/`.
