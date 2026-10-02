FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Download tuning, set by the platform (lower it on networks that stall parallel downloads)
ARG NPM_CONFIG_MAXSOCKETS=15
ARG NPM_CONFIG_FETCH_RETRIES=5
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund
COPY . .
# The platform sets $PORT; server.js never hardcodes it.
CMD ["node", "server.js"]
