# Classy

marketing reimagined

Watch a reel next to its predicted TRIBE V2 brain response. Compare reels. Ask Classy about the numbers.

Demo: https://classy-poc-260807.web.app

## Stack

App: React, Vite, Tailwind, Three.js  
Brain: Meta TRIBE V2 on fsaverage5  
Chat: Firebase AI Logic (Gemini) with knowledge.json

## Run the app

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Add Firebase web keys to `web/.env`. Never commit `.env`.

## Deploy

```bash
cd web
npm run build
npx firebase-tools@latest deploy --only hosting
```

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

Gemini free tier is limited. Prefer billing or wait if quota hits.  
App data lives in `web/public/data/`. Root `videos/` and `outputs/` stay local.
