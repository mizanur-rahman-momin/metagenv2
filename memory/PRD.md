# StockMeta — AI Metadata Generator for Adobe Stock

## Original Problem Statement
A simple browser web app to generate submission-ready metadata (title, description, keywords) from images for Adobe Stock. Uses the user's own free Gemini API keys (2.5/3.x Flash & Flash-Lite) plus OpenRouter (GPT-4o / 4o-mini). Multiple keys rotate round-robin to avoid free-tier limits. Select a folder, process many images in parallel, move completed images to a "meta done" subfolder, export CSV/TXT, with a Stop button.

## Architecture
- **Fully client-side** React app (no backend/DB used). Folder access via the browser File System Access API (Chrome/Edge); AI calls go directly from the browser to Gemini / OpenRouter using the user's keys.
- Key files (frontend/src):
  - `components/MetaGenerator.jsx` — main dashboard, processing loop, key rotation, retries, live CSV auto-save.
  - `lib/providers.js` — direct Gemini & OpenRouter REST calls + JSON parsing.
  - `lib/fsUtils.js` — folder pick, move-to-"meta done", DONE_FOLDER.
  - `lib/imageUtils.js` — image downscale to base64.
  - `lib/exporters.js` — Adobe Stock CSV + TXT builders.
  - `lib/adobeCategories.js` — 21 official categories.
  - `constants/prompt.js` — default metadata instruction prompt.

## Users
Adobe Stock contributors batch-processing their own image folders.

## Implemented (2026-06)
- Provider selector (Gemini / OpenRouter) + model selector.
  - Gemini models: 3.7/3.6/3.5 Flash, 3.5 Flash-Lite, 3.1 Flash Lite, 3.1 Flash Lite Image, 2.5 Flash, 2.5 Flash Lite.
  - OpenRouter: free-text model id + gpt-4o / gpt-4o-mini quick picks.
- Multi-key textarea (one per line), round-robin assignment (image N → key N mod count).
- **Full failover**: on error, an image retries through every remaining key before failing.
- Folder select (File System Access) + upload-folder fallback.
- Configurable parallel concurrency (1–10).
- Optional Adobe category; CSV = Filename, Title, Keywords, Category, Releases.
- Completed images moved to "meta done" subfolder.
- **Live auto-save** of `metadata.csv` into "meta done" (grows as images finish).
- Manual CSV / TXT download.
- Stop button (finishes in-flight, keeps results).
- Per-row Retry + "retry all failed".
- Editable prompt (collapsible), settings persisted to localStorage.

## Verified
- UI renders, no console errors; CSV escaping, keyword join, JSON-fence parsing verified locally.
- **NOT verified end-to-end**: live AI generation (requires user's own API key; File System Access needs real Chrome/Edge user gesture).

## Backlog (P1/P2)
- Cost/usage meter per key.
- Inline editing of results before export.
- Auto-write CSV to selected folder root on run end.
