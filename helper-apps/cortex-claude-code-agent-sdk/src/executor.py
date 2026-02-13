"""Claude Code executor - runs tasks using Claude Agent SDK."""
import os
import shutil
import asyncio
from pathlib import Path
from datetime import datetime

from claude_agent_sdk import query, ClaudeAgentOptions

from .config import FILE_HANDLER_URL, MAX_TURNS, WORKSPACE_BASE
from .tools import upload_to_file_handler, list_workspace_files


async def execute_task(task_content: str, context_id: str, task_id: str = None) -> dict:
    """
    Execute a coding task and return result directly.
    
    Args:
        task_content: The task description
        context_id: User context for file uploads
        task_id: Optional task ID (generated if not provided)
    
    Returns:
        dict with: success, result, artifacts, error, duration_ms
    """
    task_id = task_id or f"cc-{int(datetime.now().timestamp() * 1000)}"
    workspace = (Path(WORKSPACE_BASE) / task_id).resolve()
    start_time = datetime.now()
    
    print(f"▶️  Task {task_id}")
    print(f"   📝 {task_content[:100]}{'...' if len(task_content) > 100 else ''}")
    
    try:
        # Setup minimal workspace
        workspace.mkdir(parents=True, exist_ok=True)
        original_cwd = os.getcwd()
        os.chdir(workspace)
        print(f"   📁 Workspace: {workspace}")
        
        # Run Claude
        result_text = await _run_claude(task_content, workspace)
        print(f"   ✅ Claude done: {result_text[:80] if result_text else '(empty)'}...")
        
        # Check for artifacts
        artifacts = await _upload_artifacts(workspace, context_id)
        if artifacts:
            print(f"   📤 Uploaded {len(artifacts)} files")
        
        duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
        print(f"   ⏱️  Completed in {duration_ms}ms")
        
        return {
            "success": True,
            "result": result_text,
            "artifacts": artifacts,
            "duration_ms": duration_ms
        }
        
    except asyncio.TimeoutError:
        print(f"   ⏰ Task timed out")
        return {
            "success": False,
            "result": None,
            "error": "Task timed out",
            "duration_ms": int((datetime.now() - start_time).total_seconds() * 1000)
        }
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return {
            "success": False,
            "result": None,
            "error": str(e),
            "duration_ms": int((datetime.now() - start_time).total_seconds() * 1000)
        }
    finally:
        # Cleanup
        try:
            os.chdir(original_cwd)
        except:
            pass
        try:
            if workspace.exists():
                shutil.rmtree(workspace)
        except:
            pass


async def _run_claude(task_content: str, workspace: Path) -> str:
    """Run Claude Agent SDK on the task."""
    
    # Fast, minimal system prompt
    system_prompt = """You are a fast code executor. Complete tasks with minimal steps.

RULES:
- Be FAST: Take the shortest path to completion
- If the task is a simple question/calculation, just compute and respond - no files needed
- For complex outputs (charts, documents, data), save files to current directory
- NEVER read binary files you just created
- Be concise: short responses, no fluff"""

    prompt = f"""{task_content}

If this creates files, list them at the end. If it's just a calculation/answer, just give the answer."""

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        allowed_tools=["Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
        cwd=str(workspace),
        permission_mode="acceptEdits",
        max_turns=MAX_TURNS,
        max_buffer_size=10 * 1024 * 1024,
    )

    final_response = ""
    turn_count = 0
    
    async for message in query(prompt=prompt, options=options):
        turn_count += 1
        # Extract text from assistant messages
        if hasattr(message, 'content') and message.content:
            content = message.content if isinstance(message.content, list) else [message.content]
            for block in content:
                if hasattr(block, 'text'):
                    final_response = block.text
                elif hasattr(block, 'name'):
                    print(f"   🔧 {block.name}")
    
    print(f"   📊 {turn_count} turns")
    return final_response


async def _upload_artifacts(workspace: Path, context_id: str) -> list[dict]:
    """Upload any files created in workspace."""
    artifacts = []
    
    if not workspace.exists():
        return artifacts
    
    files = list_workspace_files(str(workspace))
    
    for filepath in files:
        try:
            result = await upload_to_file_handler(
                filepath=filepath,
                file_handler_url=FILE_HANDLER_URL,
                context_id=context_id
            )
            
            artifacts.append({
                "filename": Path(filepath).name,
                "url": result.get("url", ""),
            })
        except Exception as e:
            print(f"Warning: Failed to upload {filepath}: {e}")
    
    return artifacts
