-- Rename 'project' scope to 'workspace' and repurpose 'project' as cross-workspace scope
-- Step 1: Add 'workspace' to the memory_scope enum
ALTER TYPE memory_scope ADD VALUE IF NOT EXISTS 'workspace';

-- Step 2: Update all existing 'project' rows to 'workspace'
-- After this, no rows have the old 'project' semantic meaning
UPDATE memories SET scope = 'workspace' WHERE scope = 'project';

-- Step 3: The 'project' enum value is now repurposed for cross-workspace scope.
-- No rows should have scope='project' after the UPDATE above.
-- PostgreSQL does not support removing enum values, but the semantic change is clean.

-- Step 4: Make project_id nullable for project-scoped memories (cross-workspace)
ALTER TABLE memories ALTER COLUMN project_id DROP NOT NULL;

-- Step 5: Update default scope from 'project' to 'workspace'
ALTER TABLE memories ALTER COLUMN scope SET DEFAULT 'workspace';
