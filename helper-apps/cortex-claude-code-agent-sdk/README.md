# Cortex Claude Code Executor

Minimal, bulletproof code execution service using Claude Agent SDK.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Cortex (entity assistant)                                      │
│  └── sys_tool_codingagent.js                                    │
│      └── publishes to Redis: "claude-code-tasks"                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code Executor (this service)                            │
│  └── Listens to "claude-code-tasks"                             │
│  └── Runs Claude Agent SDK in isolated workspace                │
│  └── Publishes progress to "requestProgress"                    │
│  └── Uploads artifacts to cortex-file-handler                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  User sees progress + artifacts in chat                         │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Environment Variables

```bash
# Required
export ANTHROPIC_API_KEY=sk-ant-...
export REDIS_URL=redis://localhost:6379
export FILE_HANDLER_URL=http://localhost:3000  # cortex-file-handler

# Optional
export TASK_TIMEOUT_SECONDS=1800    # 30 min default
export MAX_CONCURRENT_TASKS=5       # Concurrent limit
export MAX_TURNS=200                # Claude conversation turns
```

### 2. Run with Docker (recommended)

```bash
cd helper-apps/cortex-claude-code

# Build and run
docker compose up --build

# Or with external Redis
docker compose up --build -e REDIS_URL=redis://your-redis:6379
```

### 3. Run Locally (development)

```bash
cd helper-apps/cortex-claude-code

# Install Claude Code CLI (required)
npm install -g @anthropic-ai/claude-code

# Install Python deps
pip install -r requirements.txt

# Run
python -m src.main
```

## How It Works

1. **Task arrives** via Redis pub/sub channel `claude-code-tasks`
2. **Executor creates isolated workspace** in `/tmp/claude-workspaces/{taskId}/`
3. **Claude Agent SDK runs** with full tool access (Bash, Read, Write, WebSearch, etc.)
4. **Progress published** to `requestProgress` channel (same format as cortex)
5. **Artifacts uploaded** to cortex-file-handler with contextId
6. **Workspace cleaned up** after completion

## Task Format

Publish to Redis channel `claude-code-tasks`:

```json
{
  "taskId": "cc-1234567890-abc123",
  "content": "Create a Python script that analyzes sales data...",
  "contextId": "user-context-id"
}
```

## Progress Format

Published to `requestProgress` (same as existing cortex format):

```json
{
  "requestId": "cc-1234567890-abc123",
  "progress": 0.5,
  "info": "🔧 Using Bash...",
  "data": null
}
```

On completion:
```json
{
  "requestId": "cc-1234567890-abc123",
  "progress": 1.0,
  "info": "✅ Task completed",
  "data": "{\"message\": \"Created report.pdf\", \"artifacts\": [{\"filename\": \"report.pdf\", \"url\": \"https://...\"}]}"
}
```

## Capabilities

Claude has full access to:

| Tool | What It Does |
|------|--------------|
| `Bash` | Run any shell command |
| `Read` | Read files |
| `Write` | Create/overwrite files |
| `Edit` | Patch files |
| `WebSearch` | Search the internet |
| `WebFetch` | Download URLs |

Plus the container includes:
- Python 3.12 + pip
- Node.js 22 + npm
- git, curl, ffmpeg, imagemagick, pandoc
- Claude can install additional packages as needed

## Isolation Model

- **Per-task workspace**: Each task runs in `/tmp/claude-workspaces/{taskId}/`
- **Concurrency limit**: Configurable via `MAX_CONCURRENT_TASKS`
- **Timeout**: Tasks killed after `TASK_TIMEOUT_SECONDS`
- **Cleanup**: Workspace deleted after artifacts uploaded

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `FILE_HANDLER_URL` | `http://localhost:3000` | cortex-file-handler |
| `TASK_TIMEOUT_SECONDS` | `1800` | Max task duration |
| `MAX_CONCURRENT_TASKS` | `5` | Concurrent limit |
| `MAX_TURNS` | `200` | Claude turns per task |
| `WORKSPACE_BASE` | `/tmp/claude-workspaces` | Workspace directory |

## Troubleshooting

**Task not starting:**
- Check Redis connectivity: `redis-cli ping`
- Verify ANTHROPIC_API_KEY is set
- Check logs: `docker compose logs -f`

**Task timing out:**
- Increase `TASK_TIMEOUT_SECONDS`
- Check if task is stuck in a loop

**Artifacts not uploading:**
- Verify FILE_HANDLER_URL is accessible
- Check file-handler logs

**Claude errors:**
- Check ANTHROPIC_API_KEY is valid
- Verify Claude Code CLI is installed: `claude --version`
