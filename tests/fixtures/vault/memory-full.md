---
id: mem_full_abc
title: Full example memory
type: pattern
scope: workspace
workspace_id: agent-brain
project_id: PERSONAL
author: chris
source: manual
session_id: null
tags:
  - hooks
  - snippets
  - flag/verify
version: 3
created: '2026-04-21T10:15:00.000Z'
updated: '2026-04-21T11:02:00.000Z'
verified: '2026-04-21T11:02:00.000Z'
verified_by: chris
archived: null
embedding_model: 'amazon.titan-embed-text-v2:0'
embedding_dimensions: 1024
metadata: {}
flags:
  - id: f_xyz
    type: verify
    severity: needs_review
    reason: referenced file may be renamed
    created: '2026-04-21T10:20:00.000Z'
    resolved: null
    resolved_by: null
    related: mem_other
    similarity: 0.91
---
# Full example memory

Body paragraph with two lines.
Second line of body.

## Relationships

- supersedes:: [[mem_old]] — id: r_1, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: consolidation
- related:: [[mem_sibling]] — id: r_2, confidence: 0.8, by: alice, at: 2026-04-21T10:20:00.000Z, via: manual

## Comments

> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc
> Confirmed still accurate after April sync.

> [!comment] alice · 2026-04-21T11:30:00.000Z · c_def
> Added CI check, see PR #42.
