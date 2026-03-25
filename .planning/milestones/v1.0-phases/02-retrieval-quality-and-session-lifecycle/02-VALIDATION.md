---
phase: 2
slug: retrieval-quality-and-session-lifecycle
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-23
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                          |
| ---------------------- | ---------------------------------------------- |
| **Framework**          | vitest                                         |
| **Config file**        | `vitest.config.ts`                             |
| **Quick run command**  | `npx vitest run --reporter=verbose`            |
| **Full suite command** | `npx vitest run --reporter=verbose --coverage` |
| **Estimated runtime**  | ~15 seconds                                    |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement      | Test Type   | Automated Command                                                                                    | File Exists          | Status  |
| -------- | ---- | ---- | ---------------- | ----------- | ---------------------------------------------------------------------------------------------------- | -------------------- | ------- |
| 02-01-01 | 01   | 1    | RETR-02          | unit        | `npx vitest run tests/unit/scoring.test.ts -x`                                                       | No (W0)              | pending |
| 02-01-02 | 01   | 1    | RETR-03          | compile     | `npx tsc --noEmit`                                                                                   | N/A (type rename)    | pending |
| 02-02-01 | 02   | 2    | SCOP-03          | compile     | `npx tsc --noEmit`                                                                                   | N/A (repo update)    | pending |
| 02-02-02 | 02   | 2    | RETR-01, RETR-03 | integration | `npx vitest run tests/integration/memory-search.test.ts tests/integration/memory-scoping.test.ts -x` | Yes (needs update)   | pending |
| 02-03-01 | 03   | 3    | RETR-04          | compile     | `npx tsc --noEmit`                                                                                   | N/A (service method) | pending |
| 02-03-02 | 03   | 3    | RETR-04, RETR-05 | integration | `npx vitest run tests/integration/session-start.test.ts -x`                                          | No (W0)              | pending |

_Status: pending / green / red / flaky_

---

## Wave 0 Requirements

- [ ] `tests/unit/scoring.test.ts` -- unit tests for `computeRelevance()` and `exponentialDecay()` (created by Plan 02-01 Task 1 via TDD)
- [ ] `tests/integration/memory-search.test.ts` -- update existing `.similarity` references to `.relevance` (updated by Plan 02-02 Task 2)
- [ ] `tests/integration/memory-scoping.test.ts` -- verify no stale `.similarity` field references (verified by Plan 02-02 Task 2)
- [ ] `tests/integration/session-start.test.ts` -- integration tests for `memory_session_start` tool (created by Plan 02-03 Task 2)

_Existing vitest infrastructure from Phase 1 covers framework requirements._

---

## Manual-Only Verifications

_All phase behaviors have automated verification._

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
