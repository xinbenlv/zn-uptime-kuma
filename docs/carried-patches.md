# Carried Patches Policy

This repo uses a carried patch queue on top of upstream `origin/main`.

## CPQ layers

- `cpq-cornerstone-*` — local foundation and workflow carries
- `patch-fix-test-pr*` — upstream-bound test fixes
- `patch-fix-func-pr*` — upstream-bound functional fixes
- `patch-feat-pr*` — upstream-bound feature carries
- `cpq-capstone-*` — top-of-stack branding and metadata carries

Required queue order inside `cpq-body`:

1. `patch-fix-test-pr*`
2. `patch-fix-func-pr*`
3. `patch-feat-pr*`

## Sources of truth

- Policy and workflow overview: `docs/carried-patches.md`
- Live patch metadata ledger: `docs/carried-patch-ledger.yaml`
- Full patch rationale: the Markdown commit message body of each carried patch commit

## Queue invariants

- `cpq-cornerstone-0`, `cpq-capstone-1`, and `cpq-capstone-2` are required structural patches in the active queue, each exactly once.
- `cpq-cornerstone-0` must appear before any capstone.
- `cpq-capstone-1` must appear before `cpq-capstone-2`.
- Patch buckets are optional, but if present they must stay ordered as `patch-fix-test-pr*` -> `patch-fix-func-pr*` -> `patch-feat-pr*`.
- `cpq-capstone-2` is the canonical metadata snapshot for the current queue.
- `cpq-head` must point to `cpq-capstone-2`.
- Any mutation anywhere in `cpq-base..cpq-head` invalidates the old `cpq-capstone-2`.

## Ledger rules

- `docs/carried-patch-ledger.yaml` records the current active patch set only.
- Keep the ledger minimal: patch id, current commit, upstream PR URL if applicable.
- `cpq-capstone-2` uses `current_commit: cpq-head` because a self-hash cannot be embedded inside itself.
- Regenerate the ledger only after the rest of the queue is finalized.

## Commit message rules

Every carried patch commit must have:

- a stable patch-id subject line
- a Markdown body with `## Summary` and `## Drop condition` sections
- machine-readable metadata in body frontmatter: `upstream:` and `files:`

## Queue maintenance rule

When updating to a newer upstream `origin/main`, reevaluate every carried patch, replay only the still-needed carries in bucket order, then rebuild `cpq-capstone-2` last.

## Push gate

Do not push a mutated queue until all are true:

- carried commit bodies are complete
- `docs/carried-patch-ledger.yaml` matches the current queue
- `cpq-capstone-2` was rebuilt last
- `cpq-head` points to the rebuilt `cpq-capstone-2`
