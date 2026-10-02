# --- front-end assets (Vite) built for production ---
FROM node:20-slim AS assets
WORKDIR /app
COPY . .
# Download tuning, set by the platform (lower it on networks that stall parallel downloads)
ARG NPM_CONFIG_MAXSOCKETS=15
ARG NPM_CONFIG_FETCH_RETRIES=5
RUN --mount=type=cache,target=/root/.npm if [ -f package.json ]; then npm install --no-audit --no-fund && npm run build; fi; mkdir -p public/build

# --- PHP runtime ---
FROM php:8.3-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip \
 && rm -rf /var/lib/apt/lists/* \
 && docker-php-ext-install pdo_mysql mysqli bcmath opcache \
 && php -m | grep -qi '^pdo_mysql$' && php -m | grep -qi '^pdo_sqlite$' \
 && a2enmod rewrite headers \
 && echo 'ServerName localhost' > /etc/apache2/conf-enabled/servername.conf \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

ENV APACHE_DOCUMENT_ROOT=/var/www/html/public PORT=8080 COMPOSER_ALLOW_SUPERUSER=1
RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \
 && sed -ri 's!/var/www/!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf \
 && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf \
 && sed -ri 's/^Listen 80$/Listen ${PORT}/' /etc/apache2/ports.conf \
 && sed -ri 's/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/' /etc/apache2/sites-available/000-default.conf

WORKDIR /var/www/html
COPY composer.json composer.loc[k] ./
ARG COMPOSER_MAX_PARALLEL_HTTP=12
RUN --mount=type=cache,target=/root/.composer/cache composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction --no-progress
COPY . .
COPY --from=assets /app/public/build ./public/build
RUN composer dump-autoload --optimize --no-dev --no-interaction \
 && sed -i 's/\r$//' docker/entrypoint.sh \
 && mkdir -p storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache \
 && chown -R www-data:www-data storage bootstrap/cache

CMD ["sh", "docker/entrypoint.sh"]
