---
phase: 4
slug: agent-autonomy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | AUTO-02 | integration | `npx vitest run tests/integration/prompt-resource.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | AUTO-01 | integration | `npx vitest run tests/integration/session-lifecycle.test.ts -t "autonomous"` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 1 | AUTO-04 | unit + integration | `npx vitest run tests/unit/budget.test.ts && npx vitest run tests/integration/session-lifecycle.test.ts -t "budget"` | ❌ W0 | ⬜ pending |
| 04-02-03 | 02 | 1 | AUTO-05 | unit + integration | `npx vitest run tests/unit/dedup.test.ts && npx vitest run tests/integration/duplicate-detection.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | AUTO-03 | integration | `npx vitest run tests/integration/session-lifecycle.test.ts -t "session-review"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/budget.test.ts` — stubs for AUTO-04 budget logic (threshold, counting, exceeded detection)
- [ ] `tests/unit/dedup.test.ts` — stubs for AUTO-05 threshold comparison and scope logic
- [ ] `tests/integration/session-lifecycle.test.ts` — stubs for AUTO-01, AUTO-03, AUTO-04 (session_id creation, budget tracking, autonomous writes)
- [ ] `tests/integration/duplicate-detection.test.ts` — stubs for AUTO-05 (dedup against existing memories, scope-aware checking, soft reject response)
- [ ] `tests/integration/prompt-resource.test.ts` — stubs for AUTO-02 (prompt registration and content verification)
- [ ] Migration for `sessions` table — `drizzle-kit generate` then `drizzle-kit migrate`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Claude Code stop hook triggers session-end review | AUTO-03 | Requires live Claude Code session with hooks configured | 1. Configure stop hook template 2. Start session 3. Have agent work on a task 4. Let agent stop 5. Verify session-review memory was created |
| Prompt resource appears in MCP client | AUTO-02 | Requires MCP client UI to list prompts | 1. Connect MCP Inspector 2. Verify `memory-guidance` prompt listed 3. Invoke and verify content returned |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
