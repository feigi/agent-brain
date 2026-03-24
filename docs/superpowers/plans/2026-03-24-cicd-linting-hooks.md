# CI/CD, Linting, and Pre-commit Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ESLint, Prettier, Husky pre-commit hook, and GitHub Actions CI to agent-brain.

**Architecture:** Install and configure linting/formatting tools, wire them into package.json scripts, add a Husky pre-commit hook that formats and lints the whole project, and a GitHub Actions workflow that runs typecheck + lint + format-check + unit tests on push/PR.

**Tech Stack:** ESLint 9.x (flat config), typescript-eslint, Prettier 3.x, Husky, GitHub Actions, Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-cicd-linting-hooks-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add devDependencies + scripts |
| `eslint.config.mjs` | Create | ESLint flat config with TS + Prettier compat |
| `.prettierrc` | Create | Prettier formatting options |
| `.prettierignore` | Create | Files Prettier should skip |
| `vitest.ci.config.ts` | Create | Unit-test-only Vitest config (no globalSetup) |
| `tsconfig.json` | Modify | Add `vitest.ci.config.ts` and `eslint.config.mjs` to `include` |
| `.husky/pre-commit` | Create | Pre-commit hook script |
| `.github/workflows/ci.yml` | Create | GitHub Actions CI workflow |

---

### Task 1: Install dependencies and add scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
npm install --save-dev eslint @eslint/js typescript-eslint eslint-config-prettier prettier husky
```

- [ ] **Step 2: Add scripts to package.json**

Add these scripts (leave existing scripts untouched):

```json
"lint": "eslint .",
"format": "prettier --write .",
"format:check": "prettier --check .",
"typecheck": "tsc --noEmit",
"test:unit": "vitest run --config vitest.ci.config.ts",
"prepare": "husky"
```

- [ ] **Step 3: Initialize Husky**

Run:
```bash
npx husky
```

Expected: Creates `.husky/` directory.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .husky/
git commit -m "chore: add eslint, prettier, husky devDependencies and scripts"
```

---

### Task 2: Configure ESLint

**Files:**
- Create: `eslint.config.mjs`
- Modify: `tsconfig.json:18` (add to `include`)

- [ ] **Step 1: Create ESLint config**

Create `eslint.config.mjs`:

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  { ignores: ["node_modules/", "dist/", ".worktrees/", "drizzle/"] },
);
```

- [ ] **Step 2: Add `eslint.config.mjs` to tsconfig include**

In `tsconfig.json`, change the `include` array from:

```json
"include": ["src/**/*", "tests/**/*", "drizzle.config.ts", "vitest.config.ts"]
```

to:

```json
"include": ["src/**/*", "tests/**/*", "drizzle.config.ts", "vitest.config.ts", "vitest.ci.config.ts"]
```

- [ ] **Step 3: Run lint to verify it works**

Run:
```bash
npm run lint
```

Expected: Either clean output (exit 0) or a list of lint errors. Both are fine — the tool is working. Note any errors for Task 5.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs tsconfig.json
git commit -m "chore: configure eslint with typescript-eslint and prettier compat"
```

---

### Task 3: Configure Prettier

**Files:**
- Create: `.prettierrc`
- Create: `.prettierignore`

- [ ] **Step 1: Create Prettier config**

Create `.prettierrc`:

```json
{
  "trailingComma": "all",
  "tabWidth": 2,
  "useTabs": false
}
```

- [ ] **Step 2: Create Prettier ignore file**

Create `.prettierignore`:

```
node_modules/
dist/
.worktrees/
drizzle/
coverage/
```

- [ ] **Step 3: Run format check to see current state**

Run:
```bash
npm run format:check
```

Expected: May show files that need formatting. That's fine — we'll format in Task 5.

- [ ] **Step 4: Commit**

```bash
git add .prettierrc .prettierignore
git commit -m "chore: configure prettier with ignore rules"
```

---

### Task 4: Create CI-only Vitest config

**Files:**
- Create: `vitest.ci.config.ts`

- [ ] **Step 1: Create the CI vitest config**

Create `vitest.ci.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
```

Note: No `globalSetup` — that's the point. The main `vitest.config.ts` has `globalSetup` that starts Docker + runs migrations, which CI doesn't have.

- [ ] **Step 2: Run unit tests with the CI config**

Run:
```bash
npm run test:unit
```

Expected: Only unit tests run (scoring, validation, budget, dedup). No Docker, no DB setup.

- [ ] **Step 3: Commit**

```bash
git add vitest.ci.config.ts
git commit -m "chore: add vitest CI config for unit-tests-only runs"
```

---

### Task 5: Fix lint and format errors across codebase

**Files:**
- Modify: Various source files (autofix only)

- [ ] **Step 1: Run Prettier to autoformat everything**

Run:
```bash
npm run format
```

Expected: Prettier rewrites files that don't match the config. Review the diff to make sure nothing unexpected changed.

- [ ] **Step 2: Run ESLint autofix**

Run:
```bash
npm run lint -- --fix
```

Expected: ESLint fixes what it can. If unfixable errors remain, fix them manually. Common issues:
- `@typescript-eslint/no-unused-vars` — remove unused imports/variables
- `@typescript-eslint/no-explicit-any` — add types or use `unknown`

- [ ] **Step 3: Run the full check to confirm clean**

Run:
```bash
npm run format:check && npm run lint && npm run typecheck
```

Expected: All three pass with exit 0.

- [ ] **Step 4: Run tests to make sure nothing broke**

Run:
```bash
npm run test:unit
```

Expected: All unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "style: autoformat and fix lint errors across codebase"
```

---

### Task 6: Add pre-commit hook

**Files:**
- Create: `.husky/pre-commit`

- [ ] **Step 1: Create the pre-commit hook**

Create `.husky/pre-commit`:

```sh
set -e

npm run format
npm run lint -- --fix
git add -u
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x .husky/pre-commit
```

- [ ] **Step 3: Test the hook**

Run:
```bash
git add .husky/pre-commit
git commit -m "chore: add husky pre-commit hook for format + lint"
```

Expected: The pre-commit hook runs (you'll see Prettier and ESLint output), then the commit succeeds.

---

### Task 7: Add GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow file**

Run:
```bash
mkdir -p .github/workflows
```

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Unit tests
        run: npm run test:unit
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add github actions workflow for typecheck, lint, format, unit tests"
```

---

### Task 8: Verify everything end-to-end

- [ ] **Step 1: Verify all checks pass**

Run:
```bash
npm run typecheck && npm run lint && npm run format:check && npm run test:unit
```

Expected: All four pass with exit 0.

- [ ] **Step 2: Verify pre-commit hook works**

Make a trivial whitespace change to any file, stage it, and commit:

```bash
git add -u
git commit -m "test: verify pre-commit hook"
```

Expected: Hook runs format + lint, commit succeeds.

- [ ] **Step 3: Verify pre-commit hook blocks bad code**

Create a temporary file with a lint error, stage it, and try to commit:

```bash
echo 'const x = y;' > /tmp/test-lint.ts
cp /tmp/test-lint.ts src/test-lint.ts
git add src/test-lint.ts
git commit -m "test: should be blocked"
```

Expected: Commit is blocked by ESLint error. Clean up:

```bash
git reset HEAD src/test-lint.ts 2>/dev/null
rm -f src/test-lint.ts
```

- [ ] **Step 4: Clean up verification commit**

If step 2 created a commit, amend or reset it:

```bash
git reset --soft HEAD~1
```
