---
phase: 1
slug: foundation-and-core-memory
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-23
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | `vitest.config.ts` (created by Plan 01-01 Task 1) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --coverage` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Test File Mapping

Plan 01-04 creates all integration test files. Earlier plans (01-01 through 01-03) use inline verify commands (TypeScript compilation, Docker checks, grep assertions) rather than Vitest test files.

| Test File | Created By | Requirements Covered |
|-----------|------------|----------------------|
| `tests/helpers.ts` | Plan 01-04 Task 1 | (shared test utilities) |
| `tests/integration/memory-crud.test.ts` | Plan 01-04 Task 1 | CORE-01, CORE-02, CORE-03, CORE-04, CORE-06, CORE-07, CORE-08, CORE-09 |
| `tests/integration/memory-search.test.ts` | Plan 01-04 Task 1 | CORE-05 |
| `tests/integration/memory-scoping.test.ts` | Plan 01-04 Task 1 | SCOP-01, SCOP-02, SCOP-04 |

---

## Per-Task Verification Map

### Wave 1 — Plan 01-01 (Foundation)

| Task ID | Plan | Wave | Requirement | Verify Type | Automated Command | Status |
|---------|------|------|-------------|-------------|-------------------|--------|
| 01-01-01 | 01 | 1 | INFR-04, INFR-05 | inline | `npx tsc --noEmit` | ⬜ pending |
| 01-01-02 | 01 | 1 | CORE-06, CORE-07, CORE-08, CORE-09 | inline | `docker compose up -d --wait && npx drizzle-kit migrate` | ⬜ pending |

### Wave 2 — Plan 01-02 (Service Layer)

| Task ID | Plan | Wave | Requirement | Verify Type | Automated Command | Status |
|---------|------|------|-------------|-------------|-------------------|--------|
| 01-02-01 | 02 | 2 | INFR-02, INFR-03 | inline | `npx tsc --noEmit` | ⬜ pending |
| 01-02-02 | 02 | 2 | SCOP-01, SCOP-02, SCOP-04 | inline | `npx tsc --noEmit` | ⬜ pending |

### Wave 3 — Plan 01-03 (MCP Tools + Server)

| Task ID | Plan | Wave | Requirement | Verify Type | Automated Command | Status |
|---------|------|------|-------------|-------------|-------------------|--------|
| 01-03-01 | 03 | 3 | INFR-01, CORE-01 through CORE-05 | inline | `npx tsc --noEmit && grep -c "registerTool" src/tools/memory-*.ts` | ⬜ pending |
| 01-03-02 | 03 | 3 | INFR-01 | inline | `grep "StdioServerTransport" src/server.ts && grep "SIGTERM" src/server.ts` | ⬜ pending |

### Wave 4 — Plan 01-04 (Integration Tests + Verification)

| Task ID | Plan | Wave | Requirement | Verify Type | Automated Command | Status |
|---------|------|------|-------------|-------------|-------------------|--------|
| 01-04-01 | 04 | 4 | CORE-01, CORE-02, CORE-03, CORE-04, CORE-07 | integration | `npx vitest run tests/integration/memory-crud.test.ts --reporter=verbose` | ⬜ pending |
| 01-04-02 | 04 | 4 | CORE-05 | integration | `npx vitest run tests/integration/memory-search.test.ts --reporter=verbose` | ⬜ pending |
| 01-04-03 | 04 | 4 | SCOP-01, SCOP-02, SCOP-04 | integration | `npx vitest run tests/integration/memory-scoping.test.ts --reporter=verbose` | ⬜ pending |
| 01-04-04 | 04 | 4 | — | script | `npx tsx scripts/seed.ts` | ⬜ pending |

*Status: ⬜ pending / ✅ green / ❌ red / ⚠️ flaky*

---

## Wave 0 Requirements

Wave 0 test scaffolding is handled inline by the plan structure:

- [x] `vitest.config.ts` — created by Plan 01-01 Task 1 (framework config with globalSetup)
- [x] `tests/global-setup.ts` — created by Plan 01-01 Task 1 (Docker Postgres start + migration runner)
- [x] `tests/helpers.ts` — created by Plan 01-04 Task 1 (truncateAll helper, test DB factory)
- [x] `tests/integration/memory-crud.test.ts` — created by Plan 01-04 Task 1 (CORE-01, CORE-02, CORE-03, CORE-04, CORE-06, CORE-07, CORE-08, CORE-09)
- [x] `tests/integration/memory-search.test.ts` — created by Plan 01-04 Task 1 (CORE-05)
- [x] `tests/integration/memory-scoping.test.ts` — created by Plan 01-04 Task 1 (SCOP-01, SCOP-02, SCOP-04)

All test files are created by plans before they are referenced by verify commands. Plans 01-01 through 01-03 use inline verification (tsc, grep, docker) that does not depend on test files. Plan 01-04 creates and runs its own test files in the same wave.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP client connection handshake | INFR-01 | Full MCP client behavior requires stdio process spawning | Start server via `npx tsx src/server.ts`, connect with MCP Inspector, verify tool list |
| Embedding provider swap | INFR-03 | Config-only change verification | Switch EMBEDDING_PROVIDER env var, restart server, verify search still works |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or inline verification commands
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 test files are created by plans before being referenced
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
