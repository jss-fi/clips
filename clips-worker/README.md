# clips.jss.fi front door

This is the only Worker required for current Clips builds. It owns the shared project hostname and accesses both R2 buckets directly:

- `/cdn/` serves application updates.
- `/telemetry/` accepts opt-in telemetry.
- `/app/` returns `410 Gone`; the former public browser demo has been removed.
- `/download`, `/download/`, `/download/stable`, and `/download/setup` resolve the stable release metadata and redirect to the latest stable full setup installer for new PCs.

The legacy hostnames are attached to this Worker and permanently redirect to their corresponding paths on the primary hostname. The old standalone Worker source remains under `legacy/` only as a rollback reference.

```powershell
npm install
npm run types
npm run check
npm run deploy
```

Publish locally built update artifacts from the repository root with `powershell -NoProfile -ExecutionPolicy Bypass -File clips-worker\scripts\publish.ps1`. Each release is served from R2 immediately while its tagged GitHub Release is created and checksum-verified in the background. After public metadata and artifact verification, the publisher writes a per-channel completion marker. R2 keeps the three newest marked versions in each update channel; after a fourth version is archived, the oldest version is removed only after its GitHub assets pass fallback checks. Unmarked remnants from failed uploads are cleaned without occupying retention slots. Versioned `/cdn/` requests for removed artifacts return a 307 redirect to the matching GitHub asset. Nightly is the default; use `-Channel stable` or `-Channel both` when promoting a stable release.

Artifact publishing deliberately does not use Wrangler login credentials. Create an R2 API token scoped to Object Read & Write for only the update bucket, then expose its S3-compatible credentials to the publishing process as `CLIPS_R2_ACCOUNT_ID`, `CLIPS_R2_ACCESS_KEY_ID`, and `CLIPS_R2_SECRET_ACCESS_KEY`. Keep the token separate from the token or OAuth session used to deploy the Worker. The publisher refuses to fall back to broader Wrangler credentials.

Historical numeric nightly tags are retained as Git references, while their GitHub Releases use fixed-width `nightly.nNNNNNN` aliases so GitHub's paginated release list remains numerically ordered. The Worker maps the unchanged public artifact filenames to those archive tags. Use `npm run migrate:github-nightly-tags` from the repository root for a read-only migration plan; applying it requires the explicit confirmation flag printed by the command.

The Worker name, domain, and R2 bindings are generated into the ignored `wrangler.jsonc` from the repository-root `.env`; see `.env.example`.
