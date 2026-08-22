# Repository instructions

## Required release workflow

Every published build must have a user-facing entry in `src/changelog.json`.

### Worktree release gate

The standard `npm run release` command performs the required branch, worktree, and pending-change inspection. Before using any lower-level versioning, release-build, or publish command directly, inspect with `git status --short --branch` and `git worktree list --porcelain`.

Only the primary worktree on `main` may version or publish an update. If you are in a newly created or linked worktree, or on any branch other than `main`:

1. Do not run `npm run version:nightly`, create release-metadata commits, run `npm run dist:release` or `npm run dist:fresh`, or invoke `clips-worker/scripts/publish.ps1`.
2. Complete the scoped changes and run the relevant checks, including `npm run check` for application changes.
3. Commit the changes on the worktree's branch, push that branch, and open a pull request targeting `main`.
4. Report the pull request as the handoff. Publishing must happen later from the primary `main` worktree after the pull request is merged.

### Nightly release

After completing an application change intended for nightly release:

1. Add the new entry at the start of `src/changelog.json` with `"version": "next"`.
2. Commit the application changes locally. Do not push unless the user explicitly asks.
3. Run `npm run release -- <next-major.minor>-nightly`; for example, stable `0.5` is followed by `npm run release -- 0.6-nightly`.

The release command enforces the worktree gate and correct development line, checks credentials, runs `npm run check`, derives and commits the monotonically ordered nightly metadata, automatically selects ordinary or fresh runtime packaging, builds and compatibility-tests the release, publishes it, and waits until R2, CDN, and GitHub verification finish. It handles retention cleanup without blocking a verified current release on an unrelated older archive. If it fails, fix the reported issue and rerun the same command; failed metadata commits are rolled back, while prepared releases reuse only the exact checksum-verified artifacts recorded after the original build. Never add `--fresh` to a prepared release with recorded artifacts: the command rejects that unsafe combination and requires a new release/version if fresh runtime artifacts are needed. It never pushes branch commits. Do not duplicate the command's build, publication, or public-verification steps unless it reports a failure that specifically requires lower-level diagnosis.

### Stable release

Only publish stable when the user explicitly approves that specific promotion. For a stable release:

1. Add or finalize the user-facing changelog entry before building.
2. Commit the application changes locally with the first changelog entry still set to `"version": "next"`. Do not push unless explicitly asked.
3. Run `npm run release -- <major.minor>`; for example, `npm run release -- 0.6`.

The same guarded command sets the internal patch-zero SemVer, commits stable release metadata, always builds the full setup installer (restaging the media runtime only when needed), publishes the stable baseline to both channels, and verifies both metadata feeds and every referenced artifact. It never pushes branch commits.

Subject to the worktree release gate above, never finish an application-change task in the primary `main` worktree with only source edits unless the user explicitly says not to rebuild or not to publish.

## Backward compatibility for released clients

Treat every publicly distributed Clips version as an installed client that may still need to update. A change is not complete merely because the newest source and newest updater work together.

Before changing update URLs, redirects, metadata schemas, version formats, artifact names, signing requirements, runtime layouts, migration behavior, or installer contents:

1. Inspect the updater and runtime behavior in earlier public releases, including the oldest version reasonably expected to remain installed.
2. Preserve legacy endpoints and make metadata changes additive whenever possible. Do not introduce version strings, required fields, redirects, or artifact names that an older updater rejects.
3. Test representative upgrades from earlier stable and nightly builds to the proposed release, including update discovery, download, integrity validation, installation, restart, runtime migration, and rollback behavior.
4. If direct compatibility is impossible, publish and retain a compatible bridge release before changing the feed. Older clients must have an automated upgrade path to that bridge, and the bridge must understand the new format.
5. Do not remove metadata or artifacts still needed by supported upgrade paths. Keep a documented manual recovery installer as a fallback, but do not treat manual installation as a substitute for updater compatibility.

Release verification must cover the compatibility matrix, not only a fresh install and an update from the immediately previous development build.
