FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq vim nano htop \
    build-essential python3 python3-pip python3-venv \
    procps net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install gcsfuse for live-syncing /workspace/files with GCS
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt gcsfuse-bookworm main" \
    > /etc/apt/sources.list.d/gcsfuse.list \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    > /usr/share/keyrings/cloud.google.asc \
    && apt-get update && apt-get install -y --no-install-recommends fuse3 gcsfuse \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN chmod +x /app/entrypoint.sh
RUN mkdir -p /workspace /workspace/files /tmp/gcsfuse-cache

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
