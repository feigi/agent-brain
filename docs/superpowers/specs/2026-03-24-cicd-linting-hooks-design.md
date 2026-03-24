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
- **Linting:** ESLint 9.x flat config with @typescript-eslint recommended presets
- **Formatting:** Prettier 3.x with minimal config

## 1. ESLint

**Config file:** `eslint.config.mjs` (flat config format)

**Presets:** `@typescript-eslint/eslint-plugin` recommended rules + `eslint-config-prettier` to disable formatting rules that conflict with Prettier. No custom rules.

**Ignores:** `node_modules/`, `dist/`, `.worktrees/`

**New devDependencies:**
- `eslint`
- `@typescript-eslint/eslint-plugin`
- `@typescript-eslint/parser`
- `eslint-config-prettier`

**New script:** `"lint": "eslint ."`

## 2. Prettier

**Config file:** `.prettierrc` — minimal settings for consistency (no tabs, trailing commas). Rely on defaults for everything else.

**Ignore file:** `.prettierignore` — `node_modules/`, `dist/`, `.worktrees/`, `drizzle/` (generated migrations)

**New devDependency:** `prettier`

**New scripts:**
- `"format": "prettier --write ."`
- `"format:check": "prettier --check ."`

## 3. Pre-commit Hook (Husky)

**Hook manager:** Husky

**Hook file:** `.husky/pre-commit`

**Hook behavior:**
1. Run `npm run format` (Prettier formats everything)
2. Run `npm run lint -- --fix` (ESLint fixes what it can)
3. Run `git add -A` (re-stage all changes)
4. If ESLint finds unfixable errors, the commit is blocked

**New devDependency:** `husky`

**New script:** `"prepare": "husky"` (runs on `npm install` to set up git hooks)

## 4. GitHub Actions CI

**Workflow file:** `.github/workflows/ci.yml`

**Triggers:** Push to `main`, pull requests

**Environment:** Node 22 (matches LTS target)

**Steps:**
1. Checkout
2. `npm ci`
3. Typecheck: `tsc --noEmit`
4. Lint: `eslint .`
5. Format check: `prettier --check .`
6. Unit tests: `vitest run tests/unit/`

No integration tests. No Docker services.

## 5. Package.json Scripts

**New scripts:**
- `"lint": "eslint ."`
- `"format": "prettier --write ."`
- `"format:check": "prettier --check ."`
- `"typecheck": "tsc --noEmit"`
- `"test:unit": "vitest run tests/unit/"`
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
| `package.json` | Modify (scripts + devDependencies) |
