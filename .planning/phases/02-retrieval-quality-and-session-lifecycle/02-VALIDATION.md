---
phase: 2
slug: retrieval-quality-and-session-lifecycle
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose --coverage` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | RETR-01 | unit | `npx vitest run src/scoring` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | RETR-02 | unit | `npx vitest run src/scoring` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | RETR-03 | unit | `npx vitest run src/repository` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | RETR-04 | unit | `npx vitest run src/repository` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | RETR-05 | integration | `npx vitest run src/tools` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | SCOP-03 | integration | `npx vitest run src/tools` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/scoring/__tests__/composite-score.test.ts` — stubs for RETR-01, RETR-02
- [ ] `src/repository/__tests__/cross-scope-search.test.ts` — stubs for RETR-03, RETR-04
- [ ] `src/tools/__tests__/session-start.test.ts` — stubs for RETR-05, SCOP-03

*Existing vitest infrastructure from Phase 1 covers framework requirements.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
