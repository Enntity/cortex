"""Custom tools for Claude Code executor."""
import os
import httpx
from pathlib import Path


async def upload_to_file_handler(
    filepath: str,
    file_handler_url: str,
    context_id: str,
    timeout: float = 120.0
) -> dict:
    """
    Upload a file to cortex-file-handler.
    
    Returns dict with url, shortLivedUrl, filename, etc.
    """
    filepath = Path(filepath)
    if not filepath.exists():
        raise FileNotFoundError(f"File not found: {filepath}")
    
    async with httpx.AsyncClient(timeout=timeout) as client:
        with open(filepath, "rb") as f:
            files = {"file": (filepath.name, f)}
            data = {"contextId": context_id}
            
            response = await client.post(
                file_handler_url,
                files=files,
                data=data
            )
            response.raise_for_status()
            return response.json()


def list_workspace_files(workspace: str, exclude_hidden: bool = True) -> list[str]:
    """List all files in workspace that should be uploaded as artifacts."""
    workspace = Path(workspace)
    files = []
    
    for item in workspace.rglob("*"):
        if item.is_file():
            # Skip hidden files and common non-artifact files
            if exclude_hidden and any(part.startswith(".") for part in item.parts):
                continue
            if item.name in ("__pycache__", ".pyc", ".pyo"):
                continue
            files.append(str(item))
    
    return files
