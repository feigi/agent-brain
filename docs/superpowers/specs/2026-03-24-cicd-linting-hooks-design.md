# CI/CD, Linting, and Pre-commit Hook Design

**Date:** 2026-03-24
**Status:** Draft

## Goal

Add automated code quality enforcement to agent-brain: linting, formatting, type checking, unit tests in CI, and a pre-commit hook that autoformats and lints on every commit.

## Decisions

- **CI platform:** GitHub Actions
- **CI scope:** Unit tests only (no integration tests — they require Postgres+pgvector)
- **Pre-commit scope:** Entire project (repo is small)
- **Hook manager:** Husky
- **Linting:** ESLint 9.x flat config with typescript-eslint recommended presets
- **Formatting:** Prettier 3.x with minimal config

## 1. ESLint

**Config file:** `eslint.config.mjs` (flat config format)

**Presets:** `typescript-eslint` recommended rules + `eslint-config-prettier` (flat) to disable formatting rules that conflict with Prettier. No custom rules.

**Ignores:** `node_modules/`, `dist/`, `.worktrees/`

**New devDependencies:**
- `eslint`
- `@eslint/js`
- `typescript-eslint` (unified package — replaces the older separate `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`)
- `eslint-config-prettier`

**Reference config:**

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  { ignores: ["node_modules/", "dist/", ".worktrees/"] },
);
```

**New script:** `"lint": "eslint ."`

## 2. Prettier

**Config file:** `.prettierrc` — minimal settings for consistency (no tabs, trailing commas). Rely on defaults for everything else.

**Ignore file:** `.prettierignore` — `node_modules/`, `dist/`, `.worktrees/`, `drizzle/` (generated migrations), `coverage/`

**New devDependency:** `prettier`

**New scripts:**
- `"format": "prettier --write ."`
- `"format:check": "prettier --check ."`

## 3. Pre-commit Hook (Husky)

**Hook manager:** Husky

**Hook file:** `.husky/pre-commit`

**Hook behavior:**
1. `set -e` at top (fail-fast — if any step fails, the commit is blocked)
2. Run `npm run format` (Prettier formats everything)
3. Run `npm run lint -- --fix` (ESLint fixes what it can; exits non-zero on unfixable errors, blocking the commit)
4. Run `git add -u` (re-stage only tracked files — avoids accidentally staging untracked work-in-progress or ignored files)

**Note:** `git add -u` instead of `git add -A` — only re-stages files already being tracked. Untracked files are never pulled in by the hook.

**New devDependency:** `husky`

**New script:** `"prepare": "husky"` (runs on `npm install` to set up git hooks)

## 4. GitHub Actions CI

**Workflow file:** `.github/workflows/ci.yml`

**Triggers:** Push to `main`, pull requests

**Environment:** Node 22 (matches LTS target)

**Steps:**
1. Checkout
2. `npm ci`
3. Typecheck: `npm run typecheck`
4. Lint: `npm run lint`
5. Format check: `npm run format:check`
6. Unit tests: `npm run test:unit`

**Note:** A separate `vitest.ci.config.ts` is needed for CI because the main `vitest.config.ts` has a `globalSetup` that starts Docker + runs migrations (for integration tests). The CI config omits `globalSetup` and targets only `tests/unit/`.

No integration tests. No Docker services.

## 5. Package.json Scripts

**New scripts:**
- `"lint": "eslint ."`
- `"format": "prettier --write ."`
- `"format:check": "prettier --check ."`
- `"typecheck": "tsc --noEmit"`
- `"test:unit": "vitest run --config vitest.ci.config.ts"`
- `"prepare": "husky"`

**Unchanged:** `"test": "vitest run"` (runs all tests including integration)

## Files Created/Modified

| File | Action |
|------|--------|
| `eslint.config.mjs` | Create |
| `.prettierrc` | Create |
| `.prettierignore` | Create |
| `.husky/pre-commit` | Create |
| `.github/workflows/ci.yml` | Create |
| `vitest.ci.config.ts` | Create (unit-tests-only config for CI) |
| `tsconfig.json` | Modify (add `vitest.ci.config.ts` to `include`) |
| `package.json` | Modify (scripts + devDependencies) |
