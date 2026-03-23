---
phase: 3
slug: team-collaboration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | TEAM-01 | integration | `npx vitest run tests/integration/access-control.test.ts -t "shared project" -x` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | TEAM-02 | integration | `npx vitest run tests/integration/access-control.test.ts -t "author tracking" -x` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | TEAM-03 | integration | `npx vitest run tests/integration/access-control.test.ts -t "provenance" -x` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 1 | TEAM-04 | integration | `npx vitest run tests/integration/comment.test.ts -t "create comment" -x` | ❌ W0 | ⬜ pending |
| 03-01-05 | 01 | 1 | TEAM-05 | integration | `npx vitest run tests/integration/comment.test.ts -t "preserves original" -x` | ❌ W0 | ⬜ pending |
| 03-01-06 | 01 | 1 | TEAM-06 | integration | `npx vitest run tests/integration/access-control.test.ts -t "verify" -x` | ❌ W0 | ⬜ pending |
| 03-01-07 | 01 | 1 | TEAM-07 | integration | `npx vitest run tests/integration/access-control.test.ts -t "stale" -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/access-control.test.ts` — stubs for TEAM-01, TEAM-02, TEAM-03, TEAM-06, TEAM-07
- [ ] `tests/integration/comment.test.ts` — stubs for TEAM-04, TEAM-05, self-comment block, archived block, capabilities
- [ ] `tests/integration/team-activity.test.ts` — stubs for session tracking, team_activity, memory_list_recent
- [ ] `tests/unit/validation.test.ts` — stubs for slug validation, content validation
- [ ] Update `tests/helpers.ts` — add comments and session_tracking to truncateAll()

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
