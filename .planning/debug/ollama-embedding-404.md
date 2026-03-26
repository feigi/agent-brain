---
status: investigating
trigger: "MCP memory_session_start fails with Ollama embedding error: HTTP 404 - model nomic-embed-text not found"
created: 2026-03-24T00:00:00Z
updated: 2026-03-24T00:00:00Z
---

## Current Focus

hypothesis: Ollama container does not have the nomic-embed-text model pulled, or docker-compose does not auto-pull it on startup
test: Check docker-compose.ollama.yml for model pull config, check running container for available models
expecting: Either the compose file lacks auto-pull or the model is missing from the container
next_action: Read docker-compose.ollama.yml, .env, and Ollama provider source code

## Symptoms

expected: memory_session_start succeeds and returns relevant memories
actual: error: Ollama embedding failed: HTTP 404 - model "nomic-embed-text" not found
errors: HTTP 404 from Ollama at localhost:11434 - model "nomic-embed-text" not found, try pulling it first
reproduction: Call mcp**agentic-brain**memory_session_start with any project_id/user_id
started: After changing EMBEDDING_PROVIDER=mock to EMBEDDING_PROVIDER=ollama in .env

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
verification:
files_changed: []
