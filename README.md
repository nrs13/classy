# Classy

marketing reimagined

Watch a reel next to its predicted TRIBE V2 brain response. Compare reels. Ask Classy about the numbers.

Demo: https://tribev2-brain-activity-predictor.vercel.app

## Stack

App: React, Vite, Tailwind, Three.js  
Brain: Meta TRIBE V2 on fsaverage5  
Chat: Anthropic on Vercel with knowledge.json

## Run the app

```bash
cd web
npm install
vercel dev
```

`ANTHROPIC_API_KEY` lives on Vercel — see `web/.env.example`.

## Deploy

Push to `main`. Vercel auto-deploys.

## Data pipeline

Put MP4s in `videos/` as `A_V1.mp4` through `B_V5.mp4`.

```bash
pip install -r requirements.txt
python extract.py
python extract_content_events.py
python web_export.py --out web/public/data
```

Copy videos into `web/public/data/videos/` if needed.

## Layout

```
extract.py                 TRIBE inference
extract_content_events.py  speech, OCR, scene cuts
web_export.py              pack data for the web app
colab_pack_download_data.py
metadata.csv
reference/yeo2011/         Yeo 7 atlas files
web/                       frontend + public/data
```

## Metrics

like_rate = likes / plays  
amplification = plays / followers  
hook_slope = early rise in mean |activation| (first ~3s)  
peak_mean_abs = peak cortical engagement over time  
sustain_ratio = share of post hook frames at or above half peak

N=10. Descriptive only.

## Notes

App data lives in `web/public/data/`. Root `videos/` and `outputs/` stay local.
