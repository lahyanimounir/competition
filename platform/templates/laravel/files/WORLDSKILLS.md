# __WS_APP_NAME__ (Laravel)

Live URL: __WS_APP_URL__

How this repository deploys:

1. `git push origin main` triggers a build: `composer install`, `npm run build`, container image.
2. On start, `docker/entrypoint.sh` copies `.env.production` to `.env` and runs
   `php artisan migrate --force`. **If a migration fails, the deploy fails** and the
   previous version stays live - check the deployment log on the dashboard.
3. `.env.production` already contains this repository's own database credentials and a
   generated `APP_KEY`. Nothing else needs to be configured.

Local development (optional): copy `.env.example` to `.env`, run `composer install`,
`php artisan key:generate`, `php artisan migrate`, `php artisan serve`.
