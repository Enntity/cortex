#!/bin/bash
set -e

# Ensure /workspace/files exists (volume mounts replace Dockerfile-created dirs)
mkdir -p /workspace/files

# Run the CMD (default: node server.js)
exec "$@"
