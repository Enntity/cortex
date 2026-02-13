"""Configuration from environment variables."""
import os

# Anthropic (required)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

# File handler for artifact uploads
FILE_HANDLER_URL = os.environ.get("FILE_HANDLER_URL", "http://localhost:3000")

# Execution limits
TASK_TIMEOUT_SECONDS = int(os.environ.get("TASK_TIMEOUT_SECONDS", "300"))  # 5 min default
MAX_TURNS = int(os.environ.get("MAX_TURNS", "50"))  # Fewer turns for speed
WORKSPACE_BASE = os.environ.get("WORKSPACE_BASE", "/tmp/claude-workspaces")

# Concurrency
MAX_CONCURRENT_TASKS = int(os.environ.get("MAX_CONCURRENT_TASKS", "5"))

# HTTP Server
PORT = int(os.environ.get("PORT", "8080"))
