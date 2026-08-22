# Development and testing

Clips currently targets 64-bit Windows.

## Prerequisites

A source build needs:

- Windows 10 or newer on x64.
- Git and Node.js LTS.
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload.
- OBS Studio 31.1.2 runtime and SDK sources.
- FFmpeg, MPV, and libmpv development files.

The repository includes a setup script that installs missing development tools through WinGet, downloads pinned OBS/FFmpeg/MPV/libmpv archives, verifies their SHA-256 checksums, stages them under the ignored `vendor/` directory, and builds the native hosts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-prerequisites.ps1
```

The Visual Studio installation is large and can require elevation. If the script installs Node or Git, open a new terminal afterward so the updated `PATH` is available.

Install the JavaScript dependencies and start Clips:

```powershell
npm install
npm start
```

Once npm dependencies are installed, the setup script is also available as `npm run setup:prerequisites`. Pass `-Force` directly to the PowerShell script to redownload and restage the pinned media runtime, or `-SkipToolInstall` to require all system tools to already be installed.

The capture host creates private game-capture and application-audio sources for the selected game and configured audio executables. Desktop and browser audio are not mixed unless their executable is explicitly selected.

## Packaging

Run `npm run dist` for normal app updates. It writes a slim NSIS updater containing Clips, Electron, the native capture host, and the standalone MPV player, while libobs, FFmpeg, and libmpv remain in the versioned runtime under `%LOCALAPPDATA%\jss-clips\runtime`.

Run `npm run dist:bootstrap` for the installer distributed to new PCs. The bootstrap includes the complete media runtime and copies it into the persistent runtime directory on first launch. Use `npm run dist:fresh` when libobs, the capture host, FFmpeg, standalone MPV, or the native libmpv host changes; it restages those components and creates a new bootstrap installer. A full portable build remains available with `npm run dist:portable`.

`npm run dist:release` builds both the transition NSIS updater and a versioned application package. Packaged builds download, verify, and extract that application package into `%LOCALAPPDATA%\jss-clips\app-versions` in the background. The update button appears only when preparation is complete; clicking it switches the active-version pointer and restarts Clips without running an installer.

## Publishing a release

After committing the application changes and a first changelog entry whose version is `next`, run one command from the primary `main` worktree:

```powershell
npm run release -- 0.7-nightly
```

Use the development line followed by `-nightly` for a nightly, or the development line alone for an explicitly approved stable promotion (for example, `npm run release -- 0.7`). The command refuses to run outside the primary `main` worktree or with uncommitted changes. It checks the expected version line and credentials, runs the full test suite, creates and commits release metadata, selects a fresh runtime build when runtime-affecting files changed, builds the artifacts, publishes the correct channel or channels, and waits for R2, CDN, and GitHub verification. Safe retention cleanup is attempted afterward, but an unrelated older archive that cannot yet be pruned is retained and reported without invalidating the new release. Pass `--fresh` to force runtime restaging when needed.

If a build, upload, or verification step fails, fix the reported problem and run the identical command again. The workflow recognizes already-committed release metadata and resumes safely. It never pushes branch commits; publishing pushes only the immutable release tag after the public update is live.

Published update metadata is signed with Ed25519. Generate the key pair once with `npm run keys:update`, then move the private key to protected/offline storage and set `CLIPS_UPDATE_SIGNING_KEY` in `.env` to its absolute path. Commit and distribute `src/update-signing-public.pem`; never commit or copy the private key into a build machine except while producing a release. Release builds fail closed when the private key is unavailable, and clients reject missing, modified, or incorrectly signed metadata before downloading an application package.

## Test capture locally

Run both native capture integration tests:

```powershell
npm run test:capture-host
npm run test:capture-controller
```

The first test starts recording and the replay buffer, saves both files, and verifies that no `obs64.exe` process was launched. The second tests Electron's private IPC controller.

## Test the update flow locally

For a quick UI and restart test without packaging, run:

```powershell
npm run start:update-ready
```

For a real installer-to-installer update:

1. Build and install the current version with `npm run dist`.
2. Increase the version in `package.json` and run `npm run dist` again.
3. Serve `dist/` with `npm run update:serve`.
4. Close Clips and launch the installed app from PowerShell:

```powershell
$env:CLIPS_UPDATE_URL = 'http://127.0.0.1:8787'
& "$env:LOCALAPPDATA\Programs\jss clips\jss clips.exe"
```

The update icon appears after the newer installer has downloaded. The local server supports byte ranges, so this exercises the same blockmap and differential-download path as production.

## Alternate media runtimes

Use `npm run stage:obs -- -Source D:\path\to\obs-studio`, followed by `npm run stage:libobs`, to stage a different OBS installation. The staging step copies only libobs, its Direct3D backend, capture/audio plugins, muxers, and encoders; it excludes `obs64.exe`, the OBS frontend, WebSocket, browser, and Qt UI.

Use `npm run stage:ffmpeg -- -Source D:\path\to\ffmpeg.exe` or `npm run stage:mpv -- -Source D:\path\to\mpv.exe` to select alternate media builds.

Third-party media binaries are excluded from Git to keep the repository lightweight. They are bundled with published bootstrap installers and retained across slim updates. Source builds obtain verified copies through `scripts/install-prerequisites.ps1` instead of Git history.
