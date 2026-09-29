# StockMeta

Batch-generate Adobe Stock titles, descriptions and keywords with your own Gemini or OpenRouter API keys. The app runs entirely client-side; API keys stay in the browser's `localStorage`.

## Structure

- `frontend/` — Create React App (craco) UI; the app lives in `src/components/MetaGenerator.jsx`.
- `backend/` — FastAPI app (`server.py`), optional. Exposes `/api/` and `/api/status`; no database required.
- `app.py` — Vercel FastAPI entrypoint that imports `backend.server:app`.

## Local development

Frontend:

```bash
cd frontend
yarn install
yarn start
```

Backend (optional; includes the full local dev toolchain with `uvicorn`):

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.server:app --reload
```

## Deploy to Vercel

One Vercel project: FastAPI serves `/api/*` and the built React app from `frontend/build`.

- Build command (`vercel.json`): `cd frontend && yarn install --frozen-lockfile && GENERATE_SOURCEMAP=false yarn build`. Vercel provides Yarn 1 automatically from the committed `frontend/yarn.lock`.
- Python entrypoint: `app.py` (FastAPI preset). Python version from `.python-version` (3.12), Node from `.nvmrc` (22).
- `MONGO_URL` / `DB_NAME` are optional. Without them `/api/status` returns `[]`.

Deploy with `vercel` or by connecting the repository in the Vercel dashboard.
