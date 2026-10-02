# Plain static site: every file in the repository is served as-is by nginx. No build step.
FROM nginx:1.27-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY . /usr/share/nginx/html/
# Repository plumbing is not part of the website
RUN cd /usr/share/nginx/html && rm -f Dockerfile README.md nginx.conf.template .dockerignore .gitignore
# nginx's entrypoint substitutes ${PORT} (set by the platform) into the config at start.
ENV PORT=8080
