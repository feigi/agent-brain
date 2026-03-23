# Pitfalls Research

**Domain:** AI agent long-term memory system (MCP server, pgvector, embeddings, team sharing)
**Researched:** 2026-03-23
**Confidence:** HIGH (multiple sources cross-verified per pitfall)

## Critical Pitfalls

### Pitfall 1: Memory Bloat from Unchecked Writes

**What goes wrong:**
Agents are terrible at deciding what is worth remembering. Without constraints, an autonomous-write agent saves every mildly interesting observation, producing hundreds of low-value memories per session. Retrieval quality degrades as noise overwhelms signal -- search results return ten mediocre matches instead of the one that matters. Mem0 production users report context recall failures under load when memory volume grows unchecked. The fundamental unsolved problem in the field is that "agents can accumulate so much 'important' information that searching memory becomes slower than just processing the full context."

**Why it happens:**
System prompt guidance like "save what's important" is subjective. LLMs err on the side of saving because they have no penalty for over-remembering. There is no built-in feedback loop telling the agent "that memory was never useful."

**How to avoid:**
- Implement write budgets: cap memories-per-session (e.g., 5-10 max) and enforce server-side.
- Require structured categorization on write (fact, decision, pattern, preference) so each memory has a type and explicit reason.
- Build a decay mechanism from day one: memories that are never retrieved in N days get their relevance score reduced. Use a recency-weighted scoring function that multiplies semantic similarity by an exponential decay factor based on time since last access.
- Add deduplication at write time: before saving, run a similarity search against existing memories and reject or merge near-duplicates (cosine similarity > 0.92).
- Track memory access counts -- memories never retrieved after 30+ days are candidates for archival or deletion.

**Warning signs:**
- Memory count per project growing linearly with sessions (should plateau).
- Search results returning 10+ results where most are low-relevance.
- Agents ignoring retrieved memories (sign of noise fatigue).
- Storage costs growing faster than user count.

**Phase to address:**
Phase 1 (core MCP server). Write budgets and dedup must be in the initial save_note implementation, not bolted on later. Decay scoring can come in Phase 2 but the timestamp/access-count fields must exist from Phase 1.

---

### Pitfall 2: Embedding Model Lock-in and Migration Nightmare

**What goes wrong:**
You choose Amazon Titan embeddings today. Six months from now, a better model emerges (or Titan proves too weak for your use case -- benchmarks show Titan embeddings "significantly worse than current open source models"). You now need to re-embed every stored memory because mixing embedding models produces garbage results. Different models create incompatible vector spaces -- directions, distances, and neighborhood structures shift entirely. Your HNSW index, optimized for the old coordinate system, searches the wrong space.

**Why it happens:**
Teams treat the embedding model as a library dependency ("just swap it"). In reality, changing embedding models is a database migration, not a library upgrade. Every stored vector becomes invalid when the model changes.

**How to avoid:**
- Store raw text alongside embeddings, always. Never store only vectors. This is the escape hatch that makes re-embedding possible.
- Record the embedding model ID and version as metadata on every memory (e.g., `embedding_model: "amazon.titan-embed-text-v2:0"`).
- Design the abstraction layer to support parallel embedding spaces: ability to run old and new embeddings side-by-side during migration, query both, and blend results.
- Plan for re-embedding as a batch operation: build tooling that can process all memories through a new model and rebuild the vector index. On a small memory store (< 100K memories) this is hours, not days.
- Start with Titan v2 (it is cheap and works), but do not assume it is the final model. The abstraction layer in PROJECT.md is the right call -- make it real, not theoretical.

**Warning signs:**
- Raw text not stored alongside vectors (unrecoverable).
- No model version metadata on memories.
- Retrieval quality declining but no way to identify whether the model or the data is the problem.
- Benchmarking shows Titan underperforming open-source alternatives on your specific memory types.

**Phase to address:**
Phase 1 (storage layer design). The schema must include raw text, model ID, and model version from the start. The abstraction interface must be designed for swappability. Actual migration tooling can wait for Phase 2-3.

---

### Pitfall 3: Conflicting and Contradictory Memories Without Resolution

**What goes wrong:**
Agent saves "We decided to use Redis for caching" in January. In March, the team switches to Memcached and the agent saves "We decided to use Memcached for caching." Both memories exist. When a new session searches for "caching decision," both are returned. The agent now presents contradictory information or picks one arbitrarily. Vector databases are inherently non-contradictory in appearance but deeply contradictory in substance -- they store conflicting facts simultaneously without any mechanism to resolve the conflict.

**Why it happens:**
Vector similarity search has no concept of temporal precedence, supersession, or contradiction detection. Two semantically similar memories score equally regardless of which is current. Traditional RAG treats all retrieved documents as equally valid.

**How to avoid:**
- Add timestamps and use recency as a retrieval signal (not just similarity). When multiple memories match with high similarity, prefer the most recent.
- Implement an UPDATE operation: when saving a memory that is semantically very similar (>0.90 cosine) to an existing one in the same project scope, prompt for update-vs-create decision. The MCP tool should surface the existing memory and ask: "This looks like an update to an existing memory. Replace or keep both?"
- Add a `supersedes` field: when a memory explicitly replaces another, link them. Old memory gets marked as superseded but is retained for audit.
- For critical memories (decisions, architectural choices), use a "decision" type that enforces uniqueness per topic -- only one active decision per topic key.

**Warning signs:**
- Users reporting "the agent told me X but we changed that months ago."
- Multiple memories with >0.90 similarity scores on the same topic.
- No temporal weighting in retrieval results.

**Phase to address:**
Phase 1-2. Timestamps and recency weighting in Phase 1. Conflict detection and the supersedes mechanism in Phase 2. Topic-keyed decisions can be Phase 3.

---

### Pitfall 4: Memory Poisoning in Shared/Team Contexts

**What goes wrong:**
In a team-shared memory system, one compromised agent session or malicious user can inject instructions or false facts into shared memory. Unlike prompt injection (which dies with the session), memory poisoning creates persistent compromise that activates in future sessions by unrelated team members. Research demonstrates over 95% injection success rates against production agents (MINJA, NeurIPS 2025). In multi-agent architectures, contaminated memory in one agent propagates to downstream agents through shared knowledge stores.

**Why it happens:**
Memory systems are designed for convenience (easy writes), not adversarial robustness. Agents trust their own memory retrieval results. There is no provenance tracking or trust scoring to distinguish "memory written by senior dev after code review" from "memory written by agent during a potentially confused session."

**How to avoid:**
- Provenance tracking on every memory: who wrote it (user vs. agent), which session, what triggered the write. This is not optional metadata -- it is a security field.
- Trust-weighted retrieval: memories from verified human writes rank higher than agent auto-writes. Implement a trust score multiplier on retrieval.
- Content validation: memories should not contain instructions, code to execute, or prompt-like content. Sanitize on write.
- Row-level security in Postgres: enforce tenant isolation at the database level, not just the application level. A project's memories should be physically inaccessible to queries from other projects.
- Audit logging: every memory write, read, update, and delete is logged with actor, timestamp, and session context.

**Warning signs:**
- Memories containing imperative language ("always do X", "ignore previous instructions").
- Agent behavior changing after retrieving memories it did not write.
- No provenance metadata on stored memories.
- Authorization checks only at the MCP tool level, not the database level.

**Phase to address:**
Phase 1 (schema must include provenance fields from day one). Trust scoring and content validation in Phase 2. Row-level security in the auth phase. Audit logging should be continuous from Phase 1.

---

### Pitfall 5: MCP Tool Definitions Consuming the Context Window

**What goes wrong:**
Each MCP tool definition costs 550-1,400 tokens when serialized into the context window. With a memory system exposing 8-12 tools (save, search, get, update, comment, verify, archive, list_stale, plus potential variants), you burn 5,000-15,000 tokens before the agent processes any user input. If the host application connects multiple MCP servers (GitHub, Slack, your memory system, etc.), tool definitions alone can consume 55,000-143,000 tokens -- 30-70% of the context window. This directly competes with the memories you are trying to inject.

**Why it happens:**
MCP serializes the full JSON Schema for every tool into every conversation turn. Tool descriptions, parameter schemas, enums, and field descriptions are verbose by necessity. The more helpful your tool descriptions, the more tokens they cost.

**How to avoid:**
- Minimize tool count ruthlessly. Combine related operations: `manage_memory` with an `action` parameter (save/update/archive) instead of separate tools. The PROJECT.md already lists save, search, get, update, comment, verify, archive, list_stale -- that is 8 tools. Consider whether comment/verify/archive can be actions on an `update_note` tool.
- Keep descriptions concise. Avoid examples in tool descriptions (put them in system prompt guidance instead). Every word in a tool description is paid for on every turn.
- Use short, clear parameter names and minimal enum values.
- Test actual token consumption by inspecting what gets serialized. Measure before optimizing.
- Watch the MCP ecosystem for dynamic toolset support (loading tool definitions on demand), but do not depend on it for v1.

**Warning signs:**
- Agents truncating conversation history unusually early.
- Agents "forgetting" earlier parts of the conversation.
- Users reporting context window errors when using multiple MCP servers alongside yours.
- Tool definition tokens exceeding retrieved memory tokens (you're spending more on the menu than the meal).

**Phase to address:**
Phase 1 (API surface design). The number and shape of tools is an architectural decision. Get it right before users depend on the tool names. Measure token cost of your tool definitions as a Phase 1 acceptance criterion.

---

### Pitfall 6: pgvector Index Performance Cliff at Scale

**What goes wrong:**
pgvector HNSW indexes work beautifully in development (hundreds of vectors, sub-millisecond queries). In production, once the index exceeds shared_buffers, query latency becomes inconsistent (50ms to 5 seconds), QPS degrades drastically, and index builds take hours, occasionally crashing the database. At 5 million vectors on a modest RDS instance, production alerts become constant. Index memory bloat is real: HNSW on 3072-dimension vectors reaches ~77 GB at 10 million rows.

**Why it happens:**
Most pgvector content is written by developers who tested with small datasets. The HNSW algorithm requires the entire graph in memory for optimal performance. When the index spills to disk, every graph traversal becomes a random I/O operation. Additionally, pgvector cannot push down WHERE-clause filters into vector index scans, so filtering after vector search can return zero useful results.

**How to avoid:**
- Right-size from the start: at the expected scale of this project (team memories, not internet-scale), you are looking at thousands to low tens of thousands of vectors. This is comfortably within pgvector's sweet spot. Do not over-engineer for millions.
- Use Titan v2's configurable dimensions: 256 or 512 dimensions instead of 1024. Lower dimensions = smaller index = more fits in memory. For short-text memories, 256-512 dimensions likely suffice.
- Monitor index size vs. shared_buffers as a key metric. Set alerts when index reaches 60% of shared_buffers.
- For filtered queries (e.g., "memories in project X"), use a pre-filter approach: subquery to get candidate row IDs by project, then apply vector similarity only to those candidates.
- Plan RDS instance sizing around index memory needs, not just connection count.

**Warning signs:**
- Query latency variance increasing (p50 stable but p99 spiking).
- HNSW index size approaching shared_buffers allocation.
- Index rebuild operations causing connection timeouts.
- Buffer cache hit ratio dropping below 99%.

**Phase to address:**
Phase 1 (storage layer). Choose appropriate vector dimensions. Phase 2 (performance testing). Load test with realistic memory volumes. Monitoring and alerting should be in place before any team beyond the developer starts using it.

---

### Pitfall 7: Over-Engineering the Schema Before Validation

**What goes wrong:**
The team designs an elaborate schema with hierarchical memory types, graph relationships between memories, importance scores, multi-level access controls, tagging taxonomies, and relationship edges before a single real agent has used the system. Then real usage reveals that agents primarily write flat text memories and search by similarity -- 80% of the schema is unused and the remaining 20% has wrong assumptions. Migration is painful because the schema is coupled to the storage layer.

**Why it happens:**
Memory systems invite abstract thinking. "What if we need memory hierarchies? What about episodic vs. semantic memory? What about graph-of-thought relationships?" These are academically interesting but empirically unvalidated for a v1 product. Letta's experience shows that even sophisticated architectures often fail because "if the model fails to save something, it's gone" -- the bottleneck is write quality, not schema sophistication.

**How to avoid:**
- Start with the minimum viable schema: id, content (text), embedding (vector), scope (project/user), author, created_at, updated_at, last_accessed_at, access_count, memory_type (enum: fact/decision/pattern/preference), embedding_model_id. That is it for v1.
- Add fields only when a real usage pattern demands them. Track what agents actually save and search for in the first 2 weeks.
- Keep the storage abstraction layer thin: CRUD + vector search. Do not build graph traversal, hierarchical queries, or multi-hop retrieval until data proves you need them.
- Make schema migrations easy (Postgres ALTER TABLE is cheap for adding columns). Design for additive evolution, not upfront completeness.

**Warning signs:**
- Schema design discussions lasting longer than storage implementation.
- Fields in the schema that no MCP tool exposes.
- More than 15 columns in the memories table before launch.
- Planning for memory types you have never seen an agent produce.

**Phase to address:**
Phase 1 (storage design). Resist the urge to build the "complete" schema. Ship the minimal schema, instrument what agents actually write, and evolve based on data.

---

### Pitfall 8: Session-Start Memory Injection Overwhelming Context

**What goes wrong:**
The "auto-load relevant memories at session start" feature (listed in PROJECT.md requirements) sounds simple: search for relevant memories and inject them. But "relevant to what?" At session start, there is no user query yet -- only the project context. So the system retrieves the top-N most generally relevant memories, which tend to be generic and numerous. Injecting 20 memories at 200 tokens each burns 4,000 tokens of context before the user types anything. Combined with MCP tool definitions, the agent starts each session with 50%+ of its context consumed by boilerplate.

**Why it happens:**
The system optimizes for recall ("what if the agent needs this?") rather than precision. Without a user query to focus retrieval, the system falls back to broad relevance. Research shows that "sometimes less context produces better results" -- context-flooding causes the agent to thrash instead of reason.

**How to avoid:**
- Limit session-start injection to 3-5 memories maximum, with a strict token budget (e.g., 1,500 tokens).
- Use recency + access frequency as the primary ranking for session-start memories, not just semantic similarity. "Most recently updated, most frequently accessed" is a better heuristic than "most similar to project description."
- Make session-start loading lazy: inject a brief summary ("5 memories available about deployment, auth, and caching decisions") and let the agent pull specific memories on demand via search.
- Track which session-start memories the agent actually uses. If a memory is injected in 10 sessions and never referenced, stop injecting it.

**Warning signs:**
- Agents starting responses with "Based on the memories provided..." but not using them.
- Session-start token consumption growing with total memory count.
- Users experiencing slower first responses (agent processing injected context).
- Agent performance degrading as project accumulates more memories.

**Phase to address:**
Phase 2 (auto-load feature). This should be built after basic save/search works and real usage patterns emerge. Do not guess what to auto-load -- measure what agents search for most often.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Storing vectors without raw text | Saves ~50% storage | Cannot re-embed when changing models; total data loss | Never |
| Skipping provenance metadata on writes | Faster implementation | Cannot distinguish user vs. agent writes; no audit trail; memory poisoning invisible | Never |
| Using Titan 1024-dim when 256 suffices | "More dimensions = better" | 4x index size, 4x memory consumption, marginally better recall for short texts | Only if benchmarking proves meaningful quality gain |
| Single-tool-per-operation MCP design | Cleaner tool separation | Context window bloat from 8+ tool definitions on every turn | MVP only, consolidate before team adoption |
| No dedup on memory writes | Faster writes | Duplicate memories accumulate; retrieval noise grows linearly | First 2 weeks of testing only |
| Embedding at write time only | Simpler pipeline | Cannot re-embed existing memories without custom tooling | Phase 1 only, build batch re-embedding for Phase 2 |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Amazon Bedrock (Titan) | Assuming tokenizer is available for input validation | Titan does not expose a tokenizer. Validate by character count (50K char limit) or implement conservative truncation. Track input sizes and add alerts for near-limit inputs. |
| Amazon Bedrock (Titan) | Not subscribing to the model in Bedrock Marketplace | You must explicitly subscribe to the Titan Embedding model even with correct IAM permissions. Automate this in infrastructure-as-code (CDK/Terraform). |
| pgvector | Using default IVFFlat index parameters | Default `lists = rows/1000` is for demos. For production, benchmark with `lists = rows/200`. Better yet, use HNSW for this scale. |
| pgvector | Filtering with WHERE after vector search | pgvector cannot push down filters into index scans. Pre-filter candidate rows by project scope using a subquery, then apply vector similarity to the filtered set. |
| RDS Postgres | Undersizing instance for HNSW index builds | HNSW builds require maintenance_work_mem large enough for the full graph. Use Aurora Serverless to scale up during index builds, then scale back down. |
| MCP Protocol | Assuming stable session state across reconnections | MCP sessions are stateful but clients may disconnect/reconnect. Design tools to be stateless -- every call should include all necessary context (project ID, user ID), not rely on session state. |
| MCP Protocol | Relying on MCP auth for access control | MCP's authentication story is immature (only 8.5% of servers use OAuth). Implement your own auth layer and use MCP transport purely for tool invocation. |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| HNSW index exceeds shared_buffers | p99 latency spikes from <50ms to >2s; buffer hit ratio drops | Monitor index size vs. RAM; use smaller embedding dimensions; partition by scope | Index > 60% of shared_buffers |
| Embedding API latency on every write | Memory save operations take 200-500ms; user-visible lag | Async embedding pipeline; batch nearby writes; queue and process | > 50 writes/minute |
| Full-table vector scan without scope filter | Queries slow linearly with total memory count | Always pre-filter by project scope; add composite index on (project_id, embedding) | > 10K total memories across all projects |
| Re-embedding entire corpus on model change | Hours-long downtime; cost spike | Store raw text; build batch re-embedding tooling; support dual-index during migration | > 50K memories |
| Search returning too many results | Agent context flooded; reasoning quality drops | Default to top-3 results; add minimum similarity threshold (e.g., 0.7); let agent request more if needed | > 1K memories per project |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Application-level-only tenant isolation | Cross-project memory leakage; one SQL injection exposes all projects | Row-level security (RLS) in Postgres. Memories for project A should be physically inaccessible to queries running in project B's context. |
| No content sanitization on memory writes | Memory poisoning: adversary injects prompt-like instructions that persist across sessions and influence future agent behavior | Sanitize memory content on write: reject or flag content containing imperative instructions, code blocks with executable patterns, or prompt injection markers. |
| Storing sensitive data in embeddings | Embedding inversion attacks can partially reconstruct source text from vectors | Never store secrets, credentials, or PII in memory content. Add a content classification step that rejects memories containing patterns matching API keys, passwords, or personal identifiers. |
| Static API keys for MCP auth | 53% of MCP servers use long-lived static secrets; compromised key = persistent access | Use short-lived tokens (JWT with expiry), implement key rotation, and add per-session authentication. |
| No audit trail for memory operations | Cannot detect memory poisoning; no forensics capability; compliance risk (EU AI Act requires audit trails for high-risk systems) | Log every write, read, update, and delete with actor, timestamp, session ID, and operation type. Immutable audit log, not application logs. |
| Agent writes trusted equally with human writes | Poisoned agent session contaminates shared memory with equal authority | Trust-weighted retrieval: human-authored memories have higher trust scores than agent-authored memories. Flag agent-written memories as "unverified" until a human accesses or confirms them. |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Auto-loading too many memories at session start | Agent responses slow; first interaction feels sluggish; agent references irrelevant context | Lazy loading: inject a summary of available memories; let agent pull specific ones on demand. Cap at 3-5 memories, ~1,500 tokens. |
| No feedback on memory quality | Users cannot tell if memories are helping or hurting agent performance | Surface memory usage stats: "This session used 3 of 12 available memories. 2 were helpful." Track which memories get referenced. |
| Silent memory writes by agent | Users surprised by what the agent remembered; feel surveilled | Notification or summary at session end: "I saved 2 new memories: [titles]. Review?" Transparency builds trust. |
| Stale memories surfacing as current facts | Agent presents outdated decisions as current truth | Timestamp and last-verified date visible in memory retrieval. Agent should note "This memory is from 3 months ago" when surfacing old context. |
| Search returning memories from wrong project scope | Developer on project A sees memories from project B | Scope enforcement must be invisible and automatic, not dependent on the agent remembering to filter. Default scope = current project, always. |

## "Looks Done But Isn't" Checklist

- [ ] **Memory save:** Often missing deduplication check -- verify that saving "use Redis for caching" when a nearly identical memory exists triggers a merge/update prompt, not a duplicate.
- [ ] **Semantic search:** Often missing minimum similarity threshold -- verify that a query with no good matches returns empty results, not the "least bad" results.
- [ ] **Memory update:** Often missing re-embedding -- verify that updating memory text also regenerates the embedding vector. Stale embeddings on updated text = silent retrieval failures.
- [ ] **Auth/scoping:** Often missing database-level enforcement -- verify that even with a direct SQL connection, project A's memories are not readable by project B's credentials.
- [ ] **Embedding abstraction:** Often missing model metadata -- verify that every stored embedding records which model and version generated it.
- [ ] **Memory deletion:** Often missing vector index cleanup -- verify that deleting a memory also removes its vector from the HNSW index, not just the relational row.
- [ ] **Session-start loading:** Often missing token budget enforcement -- verify that auto-loaded memories are capped by token count, not just result count.
- [ ] **Decay/aging:** Often missing access tracking -- verify that every memory retrieval updates `last_accessed_at` and `access_count`. Without this, decay scoring has no signal.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Memory bloat (thousands of low-value memories) | MEDIUM | Batch-analyze memories by access count; archive those with zero retrievals in 30+ days; implement write budgets going forward. |
| Embedding model needs replacement | MEDIUM-HIGH | Re-embed all memories using stored raw text; build dual-index; cutover when new index is validated. If raw text was not stored: HIGH -- data effectively lost. |
| Conflicting memories polluting retrieval | MEDIUM | Run pairwise similarity analysis on all memories within each project; surface clusters with >0.90 similarity for manual review; implement supersession mechanism. |
| Memory poisoning detected | HIGH | Audit log analysis to identify poisoned memories by actor/session; quarantine affected memories; re-validate agent behavior; implement content sanitization to prevent recurrence. |
| Schema over-engineered, needs simplification | LOW-MEDIUM | Schema simplification is easier than schema expansion; drop unused columns; migrate data to simpler structure. More painful if application code is tightly coupled to complex schema. |
| Context window exhaustion from tool definitions | LOW | Consolidate tools (combine 8 tools into 3-4); shorten descriptions; measure token impact; can be done without data migration. |
| pgvector performance degradation | MEDIUM | Reduce vector dimensions (requires re-embedding); upgrade RDS instance; switch to DiskANN for larger scale; add scope-based pre-filtering. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Memory bloat | Phase 1: Write budgets + dedup in save implementation | Memory count per project plateaus; no duplicates with >0.92 similarity |
| Embedding lock-in | Phase 1: Schema includes raw text + model metadata | Can swap embedding model and re-embed all memories in a test environment |
| Conflicting memories | Phase 1: Timestamps + recency weighting; Phase 2: Conflict detection | Searching a topic with superseded info returns only the latest version |
| Memory poisoning | Phase 1: Provenance fields; Phase 2: Trust scoring + sanitization | Agent-written memories flagged; imperative content rejected on write |
| Context window bloat | Phase 1: Tool count + description optimization | Total tool definition tokens < 3,000 for the memory server |
| pgvector performance | Phase 1: Dimension sizing; Phase 2: Load testing | p99 query latency < 100ms at 10K memories; index fits in shared_buffers |
| Schema over-engineering | Phase 1: Ship minimal schema, instrument usage | < 12 columns in memories table at launch; zero unused fields |
| Session-start overflow | Phase 2: Token-budgeted auto-load | Session-start injection < 1,500 tokens; auto-loaded memories have >50% usage rate |

## Sources

- [The 2025 AI Agent Report: Why AI Pilots Fail](https://composio.dev/blog/why-ai-agent-pilots-fail-2026-integration-roadmap) - "Dumb RAG" and context flooding patterns
- [Memory in the Age of AI Agents (Survey)](https://arxiv.org/abs/2512.13564) - Comprehensive taxonomy of memory operations (ADD, UPDATE, DELETE, NOOP)
- [Memory for AI Agents: Context Engineering](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/) - Memory management strategies
- [The Case Against pgvector](https://alex-jacobs.com/posts/the-case-against-pgvector/) - Production pgvector scaling issues
- [pgvector Performance for Developers](https://www.crunchydata.com/blog/pgvector-performance-for-developers) - HNSW tuning and filter gotchas
- [HNSW Index Memory Bloat in Production RAG](https://tech-champion.com/database/the-vector-hangover-hnsw-index-memory-bloat-in-production-rag/) - Index sizing at scale
- [Real Faults in MCP Software: Taxonomy](https://arxiv.org/html/2603.05637v1) - 3,282 issues analyzed across MCP servers
- [MCP's Growing Pains for Production Use](https://thenewstack.io/model-context-protocol-roadmap-2026/) - Session state, scaling, auth gaps
- [MCP Server Eating Your Context Window](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative) - Tool definition token consumption (55K+ tokens)
- [Reducing MCP Token Usage by 100x](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2) - Dynamic toolset approach
- [Persistent Memory Poisoning in AI Agents](https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/) - Attack vectors and persistence
- [MINJA: Memory INJection Attack (NeurIPS 2025)](https://www.lakera.ai/blog/agentic-ai-threats-p1) - 95%+ injection success rates
- [Microsoft: AI Recommendation Poisoning](https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/) - Multi-agent contagion risk
- [AI Memory Security Best Practices](https://mem0.ai/blog/ai-memory-security-best-practices) - Provenance and trust scoring
- [Different Embedding Models, Different Spaces](https://medium.com/data-science-collective/different-embedding-models-different-spaces-the-hidden-cost-of-model-upgrades-899db24ad233) - Migration cost of model changes
- [When Good Models Go Bad](https://weaviate.io/blog/when-good-models-go-bad) - Embedding model degradation patterns
- [Amazon Titan Embeddings: How good (bad)?](https://www.philschmid.de/amazon-titan-embeddings) - Titan benchmark limitations
- [Agent Memory Solutions: Letta vs Mem0 vs Zep vs Cognee](https://forum.letta.com/t/agent-memory-solutions-letta-vs-mem0-vs-zep-vs-cognee/85) - Production lessons from existing frameworks
- [Mem0 vs Letta Compared (2026)](https://vectorize.io/articles/mem0-vs-letta) - Write quality bottleneck, architecture tradeoffs
- [Forgetting and Aging Strategies in AI Memory](https://dev.to/rijultp/forgetting-and-aging-strategies-in-ai-memory-jin) - Decay mechanisms and recency weighting
- [OWASP LLM08:2025 Vector and Embedding Weaknesses](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/) - Embedding inversion attacks
- [MCP Server Security (Equixly)](https://equixly.com/blog/2025/03/29/mcp-server-new-security-nightmare/) - 43% command injection rate
- [State of MCP Server Security 2025 (Astrix)](https://astrix.security/learn/blog/state-of-mcp-server-security-2025/) - 53% static secret reliance

---
*Pitfalls research for: AI agent long-term memory system (MCP, pgvector, embeddings, team sharing)*
*Researched: 2026-03-23*
