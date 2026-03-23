---
phase: 1
slug: foundation-and-core-memory
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | `vitest.config.ts` (Wave 0 installs) |
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

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | INFR-01 | integration | `npx vitest run tests/integration/mcp-server.test.ts -t "lists tools"` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | INFR-02 | unit | `npx vitest run tests/unit/memory-repository.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | INFR-03 | unit | `npx vitest run tests/unit/embedding-provider.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-04 | 01 | 1 | INFR-04 | integration | `npx vitest run tests/integration/schema.test.ts -t "HNSW index"` | ❌ W0 | ⬜ pending |
| 01-01-05 | 01 | 1 | INFR-05 | integration | `npx vitest run tests/integration/migrations.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 2 | CORE-01 | integration | `npx vitest run tests/integration/memory-create.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 2 | CORE-02 | integration | `npx vitest run tests/integration/memory-get.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-03 | 02 | 2 | CORE-03 | integration | `npx vitest run tests/integration/memory-update.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-04 | 02 | 2 | CORE-04 | integration | `npx vitest run tests/integration/memory-archive.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-05 | 02 | 2 | CORE-05 | integration | `npx vitest run tests/integration/memory-search.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-06 | 02 | 2 | CORE-06 | integration | `npx vitest run tests/integration/memory-create.test.ts -t "tags"` | ❌ W0 | ⬜ pending |
| 01-02-07 | 02 | 2 | CORE-07 | integration | `npx vitest run tests/integration/memory-create.test.ts -t "persist"` | ❌ W0 | ⬜ pending |
| 01-02-08 | 02 | 2 | CORE-08 | integration | `npx vitest run tests/integration/memory-create.test.ts -t "raw text"` | ❌ W0 | ⬜ pending |
| 01-02-09 | 02 | 2 | CORE-09 | integration | `npx vitest run tests/integration/memory-create.test.ts -t "metadata"` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | SCOP-01 | integration | `npx vitest run tests/integration/scoping.test.ts -t "project scope"` | ❌ W0 | ⬜ pending |
| 01-03-02 | 03 | 2 | SCOP-02 | integration | `npx vitest run tests/integration/scoping.test.ts -t "user scope"` | ❌ W0 | ⬜ pending |
| 01-03-03 | 03 | 2 | SCOP-04 | integration | `npx vitest run tests/integration/scoping.test.ts -t "no leakage"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` — framework config with globalSetup
- [ ] `tests/global-setup.ts` — Docker Postgres start + migration runner
- [ ] `tests/helpers.ts` — truncateAll helper, test DB factory
- [ ] `tests/integration/mcp-server.test.ts` — INFR-01 (tool listing, basic invocation)
- [ ] `tests/integration/schema.test.ts` — INFR-04 (HNSW index verification)
- [ ] `tests/integration/migrations.test.ts` — INFR-05
- [ ] `tests/integration/memory-create.test.ts` — CORE-01, CORE-06, CORE-07, CORE-08, CORE-09
- [ ] `tests/integration/memory-get.test.ts` — CORE-02
- [ ] `tests/integration/memory-update.test.ts` — CORE-03
- [ ] `tests/integration/memory-archive.test.ts` — CORE-04
- [ ] `tests/integration/memory-search.test.ts` — CORE-05
- [ ] `tests/integration/scoping.test.ts` — SCOP-01, SCOP-02, SCOP-04
- [ ] `tests/unit/embedding-provider.test.ts` — INFR-03 (mock provider, interface contract)
- [ ] `tests/unit/memory-repository.test.ts` — INFR-02 (repository interface)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP client connection handshake | INFR-01 | Full MCP client behavior requires stdio process spawning | Start server via `npx tsx src/server.ts`, connect with MCP Inspector, verify tool list |
| Embedding provider swap | INFR-03 | Config-only change verification | Implement mock provider, switch config, verify search still works |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
