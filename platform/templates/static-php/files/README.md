# __WS_APP_NAME__ (Static HTML/CSS/JS + PHP)

Live URL: __WS_APP_URL__

- Put everything that should be public in `public/` (HTML, CSS, JS, images, `.php` files).
- `git push origin main` builds and deploys automatically.
- Database: the platform injects `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`
  as environment variables. Read them with `getenv()` - see `public/api/db-check.php`.
- Both `pdo_mysql` and `pdo_sqlite` are available.

Run locally (optional, needs Docker):

    docker build -t my-site . && docker run -p 8080:8080 my-site
