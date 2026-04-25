# Docker-Compose Worktree Isolation Design

**Status:** Design approved 2026-04-25.

**Driver:** Phase 5 watcher impl (per `docs/superpowers/plans/2026-04-25-vault-backend-phase-5-watcher.md`) needs to run in a `git worktree` per `superpowers:subagent-driven-development`. Today's worktree → parent host-port collision (`Bind for 0.0.0.0:5432 failed: port is already allocated`) blocks parallel docker stacks. Memory `KV9Pu5pA3AFae-Wg-mpbK` (updated 2026-04-25) records the new direction: spin up dedicated worktree stacks rather than rely on `SKIP_DOCKER_START=1`.

## Goal

Allow a worktree to run its own isolated `docker-compose` stack alongside the parent's, without changing parent behavior. Minimal scope ("A-tier" per brainstorm Q1): env-driven host ports + manual operator exports. Helper scripts and dotenv integration deferred until pain motivates.

## Non-Goals

- `scripts/worktree-env.sh` helper that auto-derives ports + writes `.env.local`.
- `dotenv` package integration in test-setup.
- Programmatic detection of port collisions before `docker compose up`.
- Refactoring `scripts/seed.ts` or `src/config.ts` (they already respect `process.env.DATABASE_URL` / `OLLAMA_BASE_URL`; worktree-side overrides flow through naturally).

## Changes

### 1. `docker-compose.yml`

```yaml
services:
  postgres:
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    # ...rest unchanged

  ollama:
    ports:
      - "${OLLAMA_PORT:-11434}:11434"
    # ...rest unchanged
```

Container-internal ports stay `5432` / `11434`. Only host-side binding becomes env-driven. Default value matches today's hardcoded value, so absent env vars yield identical behavior.

### 2. `docker-compose.prod.yml`

**Unchanged.** The `agent-brain` service references `postgres:5432` and `ollama:11434` — those are internal docker-network addresses, not host ports. Production stacks run as one isolated unit; no env interpolation needed.

### 3. `tests/global-setup.ts`

Replace the two URL constants (lines 5-6) with port-derived versions:

```ts
const TEST_DB = "agent_brain_test";
const PG_PORT = process.env.POSTGRES_PORT ?? "5432";
const MAINTENANCE_URL = `postgresql://agentic:agentic@localhost:${PG_PORT}/postgres`;
export const TEST_DB_URL = `postgresql://agentic:agentic@localhost:${PG_PORT}/${TEST_DB}`;
```

Existing line 41 wiring (`DATABASE_URL: TEST_DB_URL`) carries the alt port through to drizzle-kit and the rest of the test runtime automatically.

### 4. README

Add a "Working in a worktree" subsection to `README.md` (or wherever dev-setup lives — single-source-of-truth, do not duplicate). Content:

````md
### Working in a git worktree

The default docker-compose stack binds `localhost:5432` (Postgres) and `localhost:11434` (Ollama). To run a worktree's docker stack alongside the parent's, override the host ports + project name in your worktree shell before `docker compose up`:

```bash
export COMPOSE_PROJECT_NAME=agent-brain-<worktree-slug>
export POSTGRES_PORT=5433
export OLLAMA_PORT=11435
export DATABASE_URL=postgresql://agentic:agentic@localhost:5433/agent_brain
export OLLAMA_BASE_URL=http://localhost:11435

docker compose up -d
npm test
```

Pick any free port pair. The parent repo keeps the defaults; worktree picks alt values.
````

## Operator workflow

1. Create worktree: `git worktree add ../agent-brain-phase5 feat/<branch>`.
2. `cd ../agent-brain-phase5`.
3. Export the five env vars from the README snippet (in shell, or a gitignored `.env.local` that the operator sources manually with `set -a; source .env.local; set +a`).
4. `docker compose up -d` — brings up isolated postgres + ollama.
5. `npm test` — picks up `POSTGRES_PORT` for `tests/global-setup.ts`, `DATABASE_URL` for runtime, `OLLAMA_BASE_URL` for embedder.

Parent shell, no exports: defaults flow → `5432` / `11434` / `agent-brain` project name. Unchanged behavior.

## Race & coordination

- **Both stacks running concurrently** is the supported configuration. Distinct project names give distinct container names + networks; distinct host ports avoid bind collision; volumes (`pgdata`, `ollama_data`) are project-scoped by compose, so per-project state.
- **Forgetting the exports** is the main operational hazard: an operator runs `npm test` in the worktree without setting `POSTGRES_PORT` → setup connects to default `5432` → hits parent's DB → potentially corrupts parent state. Mitigation: README note. Stronger guard (e.g. test setup refuses to run if cwd doesn't match `git rev-parse --show-toplevel` of the parent repo) deferred to B-tier scope.
- **CI runners** have no parent stack. Defaults work as before. No CI changes.

## Error handling

No new error paths. `${POSTGRES_PORT:-5432}` is core compose v2 syntax — supported everywhere. `process.env.POSTGRES_PORT ?? "5432"` is plain JS — no failure modes.

## Testing

No automated tests added. Verification is one-time manual:

1. Parent: `docker compose up -d` (default ports). `docker compose ps` shows postgres on `0.0.0.0:5432`.
2. Worktree: `export POSTGRES_PORT=5433 OLLAMA_PORT=11435 COMPOSE_PROJECT_NAME=agent-brain-test ...; docker compose up -d`. `docker compose ps` shows postgres on `0.0.0.0:5433`. Both containers running, no port-bind error.
3. Worktree: `npm test`. Test suite green.
4. Parent (other shell): `npm test`. Test suite green. No interference.

## Risks

- **Forgotten exports** (covered above).
- **A user with a custom `.env` file shadowing exports.** Compose precedence: shell env > `.env` file. Shell exports win, so this isn't a regression for anyone who currently uses `.env` files. New users following the worktree pattern will set shell vars; documentation makes this explicit.
- **Multiple worktrees on the same machine.** Each picks its own port pair. No coordination mechanism — operators choose. If two worktrees pick the same alt ports, second one fails to bind with a clear error. Acceptable for the expected case (1-2 worktrees concurrent).

## Open questions

None blocking implementation.
