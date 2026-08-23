# clips.jss.fi front door

This is the only Worker required for current Clips builds. It owns the shared project hostname and accesses both R2 buckets directly:

- `/cdn/` serves application updates.
- `/telemetry/` accepts opt-in telemetry.
- `/app/` returns `410 Gone`; the former public browser demo has been removed.
- `/download`, `/download/`, `/download/stable`, and `/download/setup` resolve the stable release metadata and redirect to the latest stable full setup installer for new PCs.

The legacy hostnames are attached to this Worker and permanently redirect to their corresponding paths on the primary hostname. The old standalone Worker source remains under `legacy/` only as a rollback reference.

Telemetry writes are guarded by shared per-client and service-level rate-limit bindings, then admitted through one strongly consistent Durable Object with a hard global R2-write budget. Keep the matching namespace IDs identical in the front-door and legacy telemetry Worker configurations so requests cannot bypass the first-layer limits by switching hostnames.

Deploy the front-door Worker before deploying the legacy telemetry Worker. The legacy binding points to the front Worker's `TelemetryAdmission` class, so retain that exported class for as long as the legacy Worker remains available.

```powershell
npm install
npm run types
npm run check
npm run deploy
```

The repository-level `npm run release -- <version>` workflow builds, publishes, and verifies a complete release; see `docs/development.md`. The lower-level `clips-worker\scripts\publish.ps1` remains available for resuming or debugging publication of artifacts that are already built. Each release is served from R2 immediately while its tagged GitHub Release is created and checksum-verified. After public metadata and artifact verification, the publisher writes a per-channel completion marker. R2 keeps the three newest marked versions in each update channel; after a fourth version is archived, the oldest version is removed only after its GitHub assets pass fallback checks. Unmarked remnants from failed uploads are cleaned without occupying retention slots. Versioned `/cdn/` requests for removed artifacts return a 307 redirect to the matching GitHub asset.

Artifact publishing deliberately does not use Wrangler login credentials. Create an R2 API token scoped to Object Read & Write for only the update bucket, then expose its S3-compatible credentials to the publishing process as `CLIPS_R2_ACCOUNT_ID`, `CLIPS_R2_ACCESS_KEY_ID`, and `CLIPS_R2_SECRET_ACCESS_KEY`. Keep the token separate from the token or OAuth session used to deploy the Worker. The publisher refuses to fall back to broader Wrangler credentials.

Historical numeric nightly tags are retained as Git references, while their GitHub Releases use fixed-width `nightly.nNNNNNN` aliases so GitHub's paginated release list remains numerically ordered. The Worker maps the unchanged public artifact filenames to those archive tags. Use `npm run migrate:github-nightly-tags` from the repository root for a read-only migration plan; applying it requires the explicit confirmation flag printed by the command.

The Worker name, domain, and R2 bindings are generated into the ignored `wrangler.jsonc` from the repository-root `.env`; see `.env.example`.
