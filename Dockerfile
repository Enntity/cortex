FROM ubuntu:22.04 AS base

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 22 (patched version 22.22.0+ for CVE-2025 security fixes)
# See: https://nodejs.org/blog/vulnerability/january-2026-dos-mitigation-async-hooks
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Build stage - install dependencies with native compilation support
FROM base AS builder
WORKDIR /app

# Install build dependencies for native modules (mongodb-client-encryption)
RUN apt-get update && apt-get install -y python3 make g++ \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy application code
COPY . .

# Production stage - minimal runtime image
FROM base AS runner
WORKDIR /app

# Create non-root user for security
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs cortex

# Install mongo_crypt_shared library for CSFLE
# This is required for Client-Side Field Level Encryption to work
RUN apt-get update && apt-get install -y curl libssl3 \
    && curl -O https://downloads.mongodb.com/linux/mongo_crypt_shared_v1-linux-x86_64-enterprise-ubuntu2204-7.0.12.tgz \
    && mkdir -p /app/mongo_crypt_lib \
    && tar -xvf mongo_crypt_shared_v1-linux-x86_64-enterprise-ubuntu2204-7.0.12.tgz -C /app/mongo_crypt_lib --strip-components=1 \
    && rm mongo_crypt_shared_v1-linux-x86_64-enterprise-ubuntu2204-7.0.12.tgz \
    && chown -R cortex:nodejs /app/mongo_crypt_lib \
    && chmod 755 /app/mongo_crypt_lib/mongo_crypt_v1.so \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set MONGOCRYPT_PATH for CSFLE - auto-detected by mongodb-client-encryption
ENV MONGOCRYPT_PATH=/app/mongo_crypt_lib/mongo_crypt_v1.so

# Copy node_modules from builder (includes compiled native modules)
COPY --from=builder --chown=cortex:nodejs /app/node_modules ./node_modules

# Copy application code
COPY --chown=cortex:nodejs . .

# Remove devDependencies to reduce image size
RUN npm prune --omit=dev

# Switch to non-root user
USER cortex

# Expose GraphQL port
EXPOSE 4000

# Health check - uses /healthcheck which bypasses API key auth
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:4000/healthcheck || exit 1

CMD ["npm", "start"]

