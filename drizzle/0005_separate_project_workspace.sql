-- Separate project_id (server deployment) from workspace_id (user workspace)
-- project_id becomes a server-level hardcoded identifier
-- workspace_id is what project_id used to be (the user's workspace/folder)

-- Step 1: Rename projects table to workspaces
ALTER TABLE projects RENAME TO workspaces;

-- Step 2: Rename project_id columns to workspace_id in all data tables
ALTER TABLE memories RENAME COLUMN project_id TO workspace_id;
ALTER TABLE sessions RENAME COLUMN project_id TO workspace_id;
ALTER TABLE session_tracking RENAME COLUMN project_id TO workspace_id;

-- Step 3: Rename the existing index
ALTER INDEX memories_project_id_idx RENAME TO memories_workspace_id_idx;

-- Step 4: Add new project_id column (deployment project identifier) to all tables
ALTER TABLE memories ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE session_tracking ADD COLUMN project_id TEXT;

-- Step 5: Backfill project_id with 'default' for existing data
UPDATE memories SET project_id = 'default' WHERE project_id IS NULL;
UPDATE sessions SET project_id = 'default' WHERE project_id IS NULL;
UPDATE session_tracking SET project_id = 'default' WHERE project_id IS NULL;

-- Step 6: Make project_id NOT NULL
ALTER TABLE memories ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE session_tracking ALTER COLUMN project_id SET NOT NULL;

-- Step 7: Create index on new project_id column
CREATE INDEX memories_project_id_idx ON memories(project_id);

-- Step 8: Update unique constraint for session_tracking
-- Old: (user_id, project_id) which is now (user_id, workspace_id)
-- New: (user_id, workspace_id, project_id) for multi-project isolation
ALTER TABLE session_tracking DROP CONSTRAINT IF EXISTS session_tracking_user_project_idx;
ALTER TABLE session_tracking ADD CONSTRAINT session_tracking_user_workspace_project_idx
  UNIQUE (user_id, workspace_id, project_id);
