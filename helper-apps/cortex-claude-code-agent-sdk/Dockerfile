FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    build-essential \
    # Common tools Claude might want
    ffmpeg \
    imagemagick \
    pandoc \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (required for Claude Code SDK)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create app user
RUN useradd -m -s /bin/bash app
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY src/ ./src/

# Create workspace directory
RUN mkdir -p /tmp/claude-workspaces && chown app:app /tmp/claude-workspaces

# Run as non-root
USER app

# Entry point
CMD ["python", "-m", "src.main"]
