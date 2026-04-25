# Docker-Compose Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `docker-compose.yml` host ports env-driven and teach `tests/global-setup.ts` to honor `POSTGRES_PORT`, so a `git worktree` can run its own isolated docker stack alongside the parent's without port-bind collisions.

**Architecture:** Three small changes — `docker-compose.yml` ports become `${POSTGRES_PORT:-5432}:5432` / `${OLLAMA_PORT:-11434}:11434`; `tests/global-setup.ts` derives its URLs from `process.env.POSTGRES_PORT`; README gains a short "Working in a git worktree" subsection. Defaults match today's hardcoded values, so all existing usage (parent shell, CI) is unchanged.

**Tech Stack:** docker-compose v2 (env interpolation already supported), Node `process.env`, plain markdown.

---

## File structure

**Modified files:**

- `docker-compose.yml` — postgres + ollama port bindings become env-driven (2 lines)
- `tests/global-setup.ts` — `MAINTENANCE_URL` + `TEST_DB_URL` derive port from `process.env.POSTGRES_PORT` (3 lines)
- `README.md` — new `### Working in a git worktree` subsection under `## Development`

**No new files. No deps. No code logic changes outside test setup.**

---

## Task 1: Env-driven host ports in `docker-compose.yml`

**Files:**

- Modify: `docker-compose.yml:5`, `docker-compose.yml:22`

- [ ] **Step 1: Verify default behavior before the change**

Run: `docker compose config --no-interpolate | grep -A1 ports | head -10`
Expected: shows `"5432:5432"` and `"11434:11434"` literally (no `${...}`).

- [ ] **Step 2: Edit `docker-compose.yml` postgres ports**

Replace line 5 (`    - "5432:5432"`) with:

```yaml
- "${POSTGRES_PORT:-5432}:5432"
```

- [ ] **Step 3: Edit `docker-compose.yml` ollama ports**

Replace line 22 (`    - "11434:11434"`) with:

```yaml
- "${OLLAMA_PORT:-11434}:11434"
```

- [ ] **Step 4: Verify default interpolation**

Run: `docker compose config | grep -A1 ports | head -10`
Expected: `published: "5432"` and `published: "11434"` (defaults applied because env vars unset).

- [ ] **Step 5: Verify override interpolation**

Run: `POSTGRES_PORT=5433 OLLAMA_PORT=11435 docker compose config | grep -A1 ports | head -10`
Expected: `published: "5433"` and `published: "11435"`.

- [ ] **Step 6: Verify the file still parses cleanly**

Run: `docker compose config --quiet`
Expected: exit code 0, no output. (`--quiet` suppresses normal output, surfaces parse errors only.)

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml
git commit -m "build(docker): env-driven host ports for worktree isolation

Allows a git worktree to run an isolated docker stack alongside
the parent's by overriding POSTGRES_PORT / OLLAMA_PORT in the
shell. Defaults preserve existing 5432 / 11434 bindings, so all
current usage (parent shell, CI) is unchanged."
```

---

## Task 2: `tests/global-setup.ts` reads `POSTGRES_PORT`

**Files:**

- Modify: `tests/global-setup.ts:5-6`

- [ ] **Step 1: Read the current head of the file to confirm line numbers**

Run: `head -10 tests/global-setup.ts`
Expected output includes:

```
const TEST_DB = "agent_brain_test";
const MAINTENANCE_URL = "postgresql://agentic:agentic@localhost:5432/postgres";
export const TEST_DB_URL = `postgresql://agentic:agentic@localhost:5432/${TEST_DB}`;
```

- [ ] **Step 2: Replace the two URL constants**

Edit `tests/global-setup.ts` so that the `TEST_DB` constant is followed by:

```ts
const PG_PORT = process.env.POSTGRES_PORT ?? "5432";
const MAINTENANCE_URL = `postgresql://agentic:agentic@localhost:${PG_PORT}/postgres`;
export const TEST_DB_URL = `postgresql://agentic:agentic@localhost:${PG_PORT}/${TEST_DB}`;
```

(The change is purely string interpolation — no other lines move.)

- [ ] **Step 3: Verify the file typechecks**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify the existing test suite still runs against default port**

Run: `npm run test:unit`
Expected: 598 tests PASS (or whatever the current count is — equals the count before this task).

- [ ] **Step 5: Verify the env override is honored**

The unit suite doesn't connect to Postgres, so it can't prove `PG_PORT` was read. Use a hermetic Node one-liner:

Run:

```bash
POSTGRES_PORT=9999 node --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("ts-node/esm", pathToFileURL("./"));' -e "import('./tests/global-setup.ts').then(m => console.log(m.TEST_DB_URL))"
```

Expected stdout: `postgresql://agentic:agentic@localhost:9999/agent_brain_test`

If `ts-node/esm` is not installed (project uses tsx via vitest), substitute:

```bash
POSTGRES_PORT=9999 npx tsx -e "import('./tests/global-setup.ts').then(m => console.log(m.TEST_DB_URL))"
```

Expected stdout: `postgresql://agentic:agentic@localhost:9999/agent_brain_test`

- [ ] **Step 6: Commit**

```bash
git add tests/global-setup.ts
git commit -m "test: derive TEST_DB_URL from POSTGRES_PORT env var

Mirrors the docker-compose change in commit <task-1-sha>. Worktree
runs export POSTGRES_PORT=5433 (matching their isolated docker
stack); test setup picks up the alt port automatically. Default
remains 5432 so parent shells and CI are unchanged."
```

(Replace `<task-1-sha>` with the actual SHA from Task 1's commit — `git log -1 --format=%h docker-compose.yml`.)

---

## Task 3: README "Working in a git worktree" subsection

**Files:**

- Modify: `README.md` (insert under `## Development`, before `### Project structure`)

- [ ] **Step 1: Find the insertion point**

Run: `grep -n '^## Development\|^### Project structure' README.md`
Expected output:

```
393:## Development
418:### Project structure
```

The new subsection goes between line 393 and line 418 — after the existing `## Development` content but before `### Project structure`.

- [ ] **Step 2: Read lines 393-418 to see what's already in the Development section**

Run: `sed -n '393,418p' README.md`

You'll see the existing dev workflow content. The new subsection slots in at the bottom of that block (right before line 418's `### Project structure`).

- [ ] **Step 3: Insert the new subsection**

Add immediately before the line `### Project structure`:

````markdown
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

Pick any free port pair. The parent repo keeps the defaults; the worktree picks alt values. `tests/global-setup.ts` reads `POSTGRES_PORT` so the test suite connects to the worktree's Postgres rather than the parent's.
````

- [ ] **Step 4: Verify the file parses**

Run: `npx prettier --check README.md`
Expected: PASS (no formatting issues).

- [ ] **Step 5: Verify the section is in the right place**

Run: `grep -n '^## \|^### ' README.md | head -25`
Expected: shows `### Working in a git worktree` between `## Development` and `### Project structure`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add 'Working in a git worktree' README subsection

Documents the COMPOSE_PROJECT_NAME / POSTGRES_PORT / OLLAMA_PORT /
DATABASE_URL / OLLAMA_BASE_URL exports a worktree needs to run an
isolated docker stack. Companion to the docker-compose + global-
setup.ts env-var changes in the previous two commits."
```

---

## Task 4: End-to-end smoke verification

This task is manual. It proves the round-trip works. No commit at the end (verification only); if a step fails, fix the underlying defect and rerun.

**Files:** None (verification only).

- [ ] **Step 1: Bring the parent stack up on default ports**

Run (in the parent repo working directory):

```bash
docker compose up -d
docker compose ps
```

Expected: postgres + ollama containers in `running` (or `healthy`) state. `docker compose ps` shows `0.0.0.0:5432->5432/tcp` and `0.0.0.0:11434->11434/tcp`.

- [ ] **Step 2: Create a throwaway worktree**

Run:

```bash
git worktree add ../agent-brain-iso-test HEAD
cd ../agent-brain-iso-test
```

Expected: worktree created at `../agent-brain-iso-test`, on the same SHA as the parent.

- [ ] **Step 3: Bring the worktree stack up on alt ports**

Run (in the worktree):

```bash
export COMPOSE_PROJECT_NAME=agent-brain-iso-test
export POSTGRES_PORT=5433
export OLLAMA_PORT=11435
export DATABASE_URL=postgresql://agentic:agentic@localhost:5433/agent_brain
export OLLAMA_BASE_URL=http://localhost:11435
docker compose up -d
docker compose ps
```

Expected: distinct containers (project name `agent-brain-iso-test`), `0.0.0.0:5433->5432/tcp` and `0.0.0.0:11435->11434/tcp`. No port-bind error.

- [ ] **Step 4: Confirm both stacks coexist**

Run (from anywhere):

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -E 'postgres|ollama'
```

Expected: four rows — parent's two containers on 5432/11434, worktree's two on 5433/11435.

- [ ] **Step 5: Run the worktree's test suite**

In the worktree (with the env vars from Step 3 still exported):

```bash
npm install   # only if node_modules wasn't symlinked
npm test
```

Expected: full test suite green. (If integration tests are slow / heavy, `npm run test:unit` is sufficient to prove the connection wiring works — POSTGRES_PORT honored.)

- [ ] **Step 6: Tear down the worktree stack + worktree**

Run (in the worktree):

```bash
docker compose down -v
cd -
git worktree remove ../agent-brain-iso-test
```

Expected: containers + volumes deleted, worktree removed. Parent stack still running on 5432/11434.

- [ ] **Step 7: Confirm parent unaffected**

Run (in parent):

```bash
docker compose ps
npm run test:unit
```

Expected: parent containers still running. Test suite green.

(No commit — verification only.)

---

## Self-review

**Spec coverage:** Spec sections "Changes 1/2/3" map to Tasks 1/2/3. "Operator workflow" + "Race & coordination" map to Task 3 README content. "Testing" smoke verification maps to Task 4. "Non-goals" all explicitly stay out of the plan. No spec requirements without a task.

**Placeholder scan:** No `TBD` / `TODO` / "implement later" / "fill in details". Task 2 Step 6 references `<task-1-sha>` which is concrete (computed via `git log -1`), not a placeholder. Task 4 references `../agent-brain-iso-test` consistently.

**Type / API consistency:** `POSTGRES_PORT` / `OLLAMA_PORT` env names appear identically in Tasks 1, 2, 3, 4. Default values `5432` / `11434` consistent across tasks. The worktree alt-port pair `5433` / `11435` appears identically in Tasks 3 and 4. README env-var list matches what Tasks 1+2 actually read (`POSTGRES_PORT`, `OLLAMA_PORT`, `DATABASE_URL`, `OLLAMA_BASE_URL`, `COMPOSE_PROJECT_NAME`).

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-docker-compose-worktree-isolation.md`.**
