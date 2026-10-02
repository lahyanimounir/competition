# __WS_APP_NAME__ (React + Vite)

Live URL: __WS_APP_URL__

- `npm run dev` for local development, `git push origin main` to deploy.
- The deployed site is a **production build** (`npm run build`) served by nginx - minified bundle,
  no dev server, no hot-reload socket.
- Build-time variables: add `VITE_API_URL` (or other `VITE_*` names declared as `ARG` in the
  Dockerfile) in the dashboard's Env panel, then redeploy.

Run locally:

    npm install
    npm run dev
