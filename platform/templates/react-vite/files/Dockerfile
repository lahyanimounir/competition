# --- build stage: install deps and produce the minified production bundle ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# Download tuning, set by the platform (lower it on networks that stall parallel downloads)
ARG NPM_CONFIG_MAXSOCKETS=15
ARG NPM_CONFIG_FETCH_RETRIES=5
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund
COPY . .
# Variables set in the dashboard are passed as build args; Vite only exposes VITE_* ones.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- run stage: static production server, no dev server, no HMR socket ---
FROM nginx:1.27-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# nginx's entrypoint substitutes ${PORT} (set by the platform) into the config at start.
ENV PORT=8080
