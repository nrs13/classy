# Classy

Watch a reel next to its predicted TRIBE V2 brain response. Compare reels. Ask Classy about the numbers.

Demo: https://tribev2-brain-activity-predictor.vercel.app

## Stack

App: React, Vite, Tailwind, react-three-fiber  
Brain: Meta TRIBE V2 on fsaverage5  
Chat: Anthropic via Vercel `/api/chat`, grounded on `knowledge.json`

## Run the app

Brain + reels only:

```bash
cd web
npm install
npm run dev
```

Ask Classy works locally too (needs Vercel CLI + API key):

```bash
cd web
npm install
vercel env pull .env.local
vercel dev
```

Set `ANTHROPIC_API_KEY` on Vercel for production. Optional: `CLASSY_MODEL`, `CLASSY_EFFORT`. See `web/.env.example`.

## Deploy

Push to `main`. Vercel auto-deploys (project root is `web/`).

## Data pipeline

Put MP4s in `videos/` at the repo root as `A_V1.mp4` through `B_V5.mp4`.

```bash
pip install -r requirements.txt
python extract.py
python extract_content_events.py
python web_export.py --out web/public/data
cp videos/*.mp4 web/public/data/videos/
```

`videos/` and `outputs/` are gitignored. The app reads from `web/public/data/`.

## Layout

```
extract.py                 TRIBE inference
extract_content_events.py  speech, OCR, scene cuts
web_export.py              pack data for the web app
colab_pack_download_data.py
metadata.csv
reference/yeo2011/         Yeo 7 atlas files
web/                       frontend, api/chat.js, public/data
```

## Metrics

like_rate = likes / plays  
amplification = plays / followers  
hook_slope = early rise in mean |activation| (first ~3s)  
peak_mean_abs = peak cortical engagement over time  
sustain_ratio = share of post hook frames at or above half peak

N=10. Descriptive only.
