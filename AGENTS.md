# Agent Guidelines for zn-uptime-kuma

## Upstream: louislam/uptime-kuma

This is a CPQ (carried patch queue) fork. See `docs/carried-patches.md` for policy.

## Authorization for upstream actions

**NEVER create or update pull requests or issues on the upstream repo (`louislam/uptime-kuma`) unless the user has explicitly asked you to AND you have confirmed with them immediately before acting.**

This covers: opening PRs, pushing to a branch that is tracked by an open upstream PR, converting drafts to ready-for-review, commenting on / closing upstream PRs or issues, opening upstream issues, and any `gh` command whose target is `louislam/uptime-kuma`.

Pushes to `origin` (`xinbenlv/zn-uptime-kuma`) do not require upstream-level confirmation — but do not treat a push to `origin` as license to open a cross-repo PR.

## Submitting PRs to upstream

This section only applies once the authorization rule above is satisfied.

Upstream has a **PR description check** workflow (`.github/workflows/pr-description-check.yml`) that auto-closes PRs whose body does not contain the phrase `"avoid unnecessary back and forth"`.

When creating or updating a PR to `louislam/uptime-kuma`:

1. **Never push a topic branch and immediately open a PR without the template applied.** The first PR body that hits upstream must already be filled out from `.github/PULL_REQUEST_TEMPLATE.md`. If you realise a PR went out without the template, close it and open a new one; do not amend-and-hope.
2. **Always use the template** from `.github/PULL_REQUEST_TEMPLATE.md` as the PR body. Fill in every section: Summary, checklist, screenshots (if UI changes).
3. The checklist `<details>` block must include the exact phrase verbatim — do not rephrase or remove it.
4. **Always create PRs in draft status.** Do not open a ready-for-review PR directly, and do not convert to ready-for-review until CI is green and the PR has been reviewed by a human.
5. Disclose any LLM/AI assistance in the PR body (required by upstream policy).

## Testing

- Test framework: Node.js native test runner (`node:test` + `assert`).
- Backend tests: `test/backend-test/*.js`
- Run: `npm run test-backend` or directly `node --test --test-reporter=spec test/backend-test/<file>.js`
- DB fixture: use `TestDB` from `test/mock-testdb.js` for isolated SQLite per test suite.
- All new features must include backend tests.

## Folder documentation

- Any folder with more than 5 files must have an in-folder `README.md`; on any change in that folder, update both that `README.md` and the parent folder's `README.md`.

## Remotes

- `origin` = our fork (`xinbenlv/zn-uptime-kuma`)
- `upstream` = upstream (`louislam/uptime-kuma`), fetching `master` → `upstream/main` only (no tags, no other branches)
- local `main` tracks `origin/main`; `origin/main` = upstream + CPQ on top
- Topic branches for upstream PRs branch from `cpq-base` (= pinned upstream ref).
