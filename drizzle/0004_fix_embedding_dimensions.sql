-- Fix embedding column dimensions to match nomic-embed-text output (768)
-- The column was incorrectly set to vector(512) via schema push

-- Step 1: Null out existing embeddings (incompatible dimensions)
UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL;

-- Step 2: Drop HNSW index (required before ALTER TYPE on vector column)
DROP INDEX IF EXISTS memories_embedding_idx;

-- Step 3: Change column dimensions
ALTER TABLE memories ALTER COLUMN embedding TYPE vector(768);

-- Step 4: Recreate HNSW index
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
