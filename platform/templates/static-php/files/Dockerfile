FROM php:8.3-apache

# pdo_sqlite ships with the official image; pdo_mysql/mysqli are compiled in here so the
# database credentials the platform provisions work out of the box. The build fails if either is missing.
RUN docker-php-ext-install pdo_mysql mysqli \
 && php -m | grep -qi '^pdo_mysql$' && php -m | grep -qi '^pdo_sqlite$' \
 && a2enmod rewrite headers \
 && echo 'ServerName localhost' > /etc/apache2/conf-enabled/servername.conf \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# Serve public/ and listen on the port the platform assigns ($PORT is read by Apache at start).
ENV APACHE_DOCUMENT_ROOT=/var/www/html/public PORT=8080
RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \
 && sed -ri 's!/var/www/!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf \
 && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf \
 && sed -ri 's/^Listen 80$/Listen ${PORT}/' /etc/apache2/ports.conf \
 && sed -ri 's/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/' /etc/apache2/sites-available/000-default.conf

COPY . /var/www/html/
RUN chown -R www-data:www-data /var/www/html
