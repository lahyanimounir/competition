#!/bin/sh
# Runs on every deploy. Any failing step stops the container, which fails the deploy and
# keeps the previous deployment live - errors are never silently swallowed.
set -e
cd /var/www/html

if [ ! -f .env ]; then
  cp .env.production .env
fi

php artisan config:clear

echo "Running migrations..."
php artisan migrate --force

php artisan config:cache
php artisan view:cache
php artisan storage:link 2>/dev/null || true   # link may already exist; harmless

chown -R www-data:www-data storage bootstrap/cache
exec apache2-foreground
