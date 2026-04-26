import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  FlagRepository,
  RelationshipRepository,
} from "../../repositories/types.js";
import type { Memory } from "../../types/memory.js";
import type { Flag } from "../../types/flag.js";
import type { Relationship } from "../../types/relationship.js";
import type { CountsByKind } from "./types.js";

async function withContext<T>(
  kind: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `migration write failed: kind=${kind} id=${id}: ${msg}`,
    );
    if (err instanceof Error && err.stack) wrapped.stack = err.stack;
    throw wrapped;
  }
}

export interface PgSource {
  readWorkspaces(): Promise<Array<{ id: string; created_at: Date }>>;
  readMemoriesWithEmbeddings(): Promise<
    Array<{ memory: Memory; embedding: number[] }>
  >;
  readComments(): Promise<
    Array<{
      id: string;
      memory_id: string;
      author: string;
      content: string;
    }>
  >;
  readFlags(): Promise<Flag[]>;
  readRelationships(): Promise<Relationship[]>;
  // Used by the CLI entry script (not this driver) for pre-run summary
  // and post-run verify. Kept on the source contract so a single reader
  // implementation can serve both phases.
  counts(): Promise<CountsByKind>;
}

export interface VaultDestination {
  workspaceRepo: Pick<WorkspaceRepository, "findOrCreate">;
  memoryRepo: Pick<MemoryRepository, "create">;
  commentRepo: Pick<CommentRepository, "create">;
  flagRepo: Pick<FlagRepository, "create">;
  relationshipRepo: Pick<RelationshipRepository, "create">;
}

export interface RunPgToVaultInput {
  source: PgSource;
  destination: VaultDestination;
  reembed: boolean;
  embedder: (content: string) => Promise<number[]>;
}

export async function runPgToVault(input: RunPgToVaultInput): Promise<void> {
  const { source, destination, reembed, embedder } = input;

  // 1. workspaces (FK target for everything else)
  const workspaces = await source.readWorkspaces();
  for (const ws of workspaces) {
    await withContext("workspace", ws.id, () =>
      destination.workspaceRepo.findOrCreate(ws.id),
    );
  }

  // 2. memories — carry-over embedding by default; re-embed when flagged
  const memories = await source.readMemoriesWithEmbeddings();
  for (const { memory, embedding } of memories) {
    await withContext("memory", memory.id, async () => {
      const vec = reembed ? await embedder(memory.content) : embedding;
      await destination.memoryRepo.create({ ...memory, embedding: vec });
    });
  }

  // 3. comments
  const comments = await source.readComments();
  for (const c of comments) {
    await withContext("comment", c.id, () =>
      destination.commentRepo.create({
        id: c.id,
        memory_id: c.memory_id,
        author: c.author,
        content: c.content,
      }),
    );
  }

  // 4. flags
  const flags = await source.readFlags();
  for (const f of flags) {
    await withContext("flag", f.id, () => destination.flagRepo.create(f));
  }

  // 5. relationships
  const rels = await source.readRelationships();
  for (const r of rels) {
    await withContext("relationship", r.id, () =>
      destination.relationshipRepo.create(r),
    );
  }
}
