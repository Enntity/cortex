FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq vim nano htop \
    build-essential python3 python3-pip python3-venv \
    procps net-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /workspace
VOLUME /workspace

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "server.js"]
