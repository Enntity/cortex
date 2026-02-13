"""Claude Code HTTP Service - synchronous code execution."""
import os
import asyncio
import signal
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from aiohttp import web

from .executor import execute_task
from .config import MAX_CONCURRENT_TASKS, TASK_TIMEOUT_SECONDS

# Semaphore for concurrency control
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TASKS)


async def handle_execute(request: web.Request) -> web.Response:
    """
    POST /execute
    
    Body: {
        "task": "string - the coding task",
        "contextId": "string - user context for file uploads",
        "taskId": "string - optional task ID"
    }
    
    Returns: {
        "success": bool,
        "result": "string - text result from Claude",
        "artifacts": [{"filename": "...", "url": "..."}],
        "error": "string - if failed",
        "duration_ms": int
    }
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response(
            {"success": False, "error": "Invalid JSON body"},
            status=400
        )
    
    task = data.get("task")
    context_id = data.get("contextId")
    task_id = data.get("taskId")
    
    if not task:
        return web.json_response(
            {"success": False, "error": "Missing 'task' field"},
            status=400
        )
    
    if not context_id:
        return web.json_response(
            {"success": False, "error": "Missing 'contextId' field"},
            status=400
        )
    
    print(f"📥 Request: {task[:60]}{'...' if len(task) > 60 else ''}")
    
    # Acquire semaphore (limit concurrent executions)
    async with _semaphore:
        try:
            result = await asyncio.wait_for(
                execute_task(task, context_id, task_id),
                timeout=TASK_TIMEOUT_SECONDS
            )
            return web.json_response(result)
        except asyncio.TimeoutError:
            print(f"⏰ Request timed out after {TASK_TIMEOUT_SECONDS}s")
            return web.json_response({
                "success": False,
                "error": f"Task timed out after {TASK_TIMEOUT_SECONDS}s"
            })
        except Exception as e:
            print(f"❌ Request error: {e}")
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)


async def handle_health(request: web.Request) -> web.Response:
    """GET /health - health check endpoint."""
    return web.json_response({"status": "ok"})


def create_app() -> web.Application:
    """Create the aiohttp application."""
    app = web.Application()
    app.router.add_post("/execute", handle_execute)
    app.router.add_get("/health", handle_health)
    return app


def main():
    """Run the HTTP server."""
    port = int(os.environ.get("PORT", 8080))
    
    print(f"🚀 Claude Code Executor starting...")
    print(f"   Port: {port}")
    print(f"   Max concurrent: {MAX_CONCURRENT_TASKS}")
    print(f"   Task timeout: {TASK_TIMEOUT_SECONDS}s")
    
    app = create_app()
    web.run_app(app, port=port, print=lambda x: print(f"🌐 {x}"))


if __name__ == "__main__":
    main()
