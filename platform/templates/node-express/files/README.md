# __WS_APP_NAME__ (Node.js / Express)

Live URL: __WS_APP_URL__

- `server.js` is the entry point. It reads the port from `$PORT` and binds `0.0.0.0`.
- CORS is enabled so a front end on another subdomain can call this API.
- DB credentials arrive as `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` (and `DATABASE_URL`).
- Add your own variables in the dashboard (Env button) and read them with `process.env.NAME`.

Run locally:

    npm install
    PORT=3000 npm start            # PowerShell: $env:PORT=3000; npm start
