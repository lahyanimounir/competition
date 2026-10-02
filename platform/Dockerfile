FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main

# Docker CLI + buildx, used to build and run competitor containers on the host engine
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Normalise line endings in case the project was edited on Windows
RUN find templates -type f \( -name '*.sh' -o -name 'Dockerfile' -o -name '*.template' \) -exec sed -i 's/\r$//' {} +

ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 80
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
