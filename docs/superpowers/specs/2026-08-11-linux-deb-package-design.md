# Linux `.deb` package for NanoAgent

**Date:** 2026-08-11  
**Status:** Approved design (awaiting implementation)  
**Branch target:** `cursor/linux-deb-package-f0da`

## Problem

Installing `@omega3_0/nanoagent` on Linux via npm (registry or `github:…`) is unreliable:

- The published `files` whitelist omits `src/` / `tsconfig.json`, so a broken git install cannot be rebuilt in place.
- `prepack` / `dist/` often does not land in the global install, leaving `/usr/local/bin/nanogent` as a broken symlink.
- Optional / native deps (`@opentui/*`, clipboard helpers, bun platform packages) and Node engine mismatches (Node 18 vs deps requiring ≥20) leave a half-working CLI.

Users need a one-shot Linux install that does not depend on npm login or a working global npm toolchain.

## Goals

1. Ship an **amd64 `.deb`** that installs working `nanogent` / `nanoagent` commands.
2. **Bundle Node 20 linux-x64** inside the package (no system Node dependency).
3. Bundle **production `node_modules`** resolved for linux-x64 (including OpenTUI natives).
4. Ship **prebuilt `dist/`** and packaged `skills/`.
5. Build via a repo script + GitHub Actions artifact / Release asset (no npm publish required).

## Non-goals (v1)

- arm64 / multi-arch packages
- `.rpm`, AppImage, Snap, Flatpak
- Hosting an apt repository
- Bundling Bun as the runtime (Node is enough for `dist/main.js`)
- Changing the npm package publish flow beyond documenting the `.deb` as the preferred Linux path

## Package shape

| Item | Value |
|------|--------|
| Package name | `nanoagent` |
| Version | From `package.json` `version` |
| Architecture | `amd64` |
| Artifact name | `nanoagent_<version>_amd64.deb` |
| Approx. size | ~50–80MB (Node + deps) |

### Filesystem layout

```text
/usr/lib/nanoagent/
  dist/                 # prebuilt JS (tsc output)
  node_modules/         # production deps for linux-x64
  skills/               # bundled skills
  package.json
  node/                 # official Node 20 linux-x64 distribution
    bin/node
    ...
/usr/bin/nanogent       # wrapper → bundled node + dist/main.js
/usr/bin/nanoagent      # same wrapper (alias)
```

### Wrapper behavior

`/usr/bin/nanogent` (and `nanoagent`) is a small shell script:

- `exec /usr/lib/nanoagent/node/bin/node /usr/lib/nanoagent/dist/main.js "$@"`
- Does not rely on system `node` or `PATH` for the runtime.

### Debian control

- `Package: nanoagent`
- `Architecture: amd64`
- `Depends:` none on `nodejs` (runtime bundled). Optional: standard libs already on Ubuntu (`libc6`, etc.) only if the Node binary requires them (normally satisfied).
- `Maintainer:` repo owner / project contact
- `Description:` short synopsis matching README

## Build approach

**Custom stage + `dpkg-deb`** (not nfpm, not full Debian source package).

### Script: `scripts/build-deb.sh`

1. Require Linux amd64 host (or document CI-only for cross). Fail clearly otherwise.
2. Clean staging dir (e.g. `.deb-stage/`).
3. Install deps (`bun install --frozen-lockfile` preferred; npm fallback).
4. `npm run build` → `dist/`.
5. Create a production `node_modules` tree for linux-x64:
   - Prefer `bun install --production --frozen-lockfile` in a clean package dir, or `npm ci --omit=dev` with platform set to linux/x64 so optional deps resolve correctly.
6. Download official Node **20.x** linux-x64 tarball from `nodejs.org`, extract into stage `usr/lib/nanoagent/node/`.
7. Copy `dist/`, production `node_modules/`, `skills/`, `package.json` into `usr/lib/nanoagent/`.
8. Write wrappers under `usr/bin/`.
9. Write `DEBIAN/control` (and optional `DEBIAN/md5sums`).
10. `dpkg-deb --build` → `dist-packages/nanoagent_<version>_amd64.deb`.

### npm script

```json
"package:deb": "bash scripts/build-deb.sh"
```

### CI

GitHub Actions workflow (e.g. `.github/workflows/package-deb.yml`):

- Triggers: tag `v*`, `workflow_dispatch`
- Runner: `ubuntu-latest` (amd64)
- Steps: checkout → setup bun/node → `bash scripts/build-deb.sh` → upload artifact; on tag, attach `.deb` to GitHub Release

## Install / verify (user)

```bash
sudo apt install ./nanoagent_<version>_amd64.deb
nanogent --help
nanogent   # TUI
```

Remove:

```bash
sudo apt remove nanoagent
```

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Optional native deps wrong platform | Build on linux amd64 CI; production install with linux/x64 |
| Node tarball URL / version drift | Pin Node minor in script (e.g. 20.19.x); checksum verify |
| Large artifact | Accept for v1; document size; do not strip incorrectly |
| `dpkg-deb` permissions | Stage with correct modes (`0755` bins, `0644` files) before build |
| Conflicts with old npm global bins | Document uninstall of `@omega3_0/nanoagent` global; `.deb` owns `/usr/bin/nanogent` |

## Success criteria

1. `scripts/build-deb.sh` produces a valid `.deb` on Ubuntu amd64 CI.
2. Fresh VM / laptop: `sudo apt install ./nanoagent_*.deb` yields working `nanogent` with no prior Node/npm setup.
3. TUI starts (`nanogent` / `nanogent tui`) without missing-module errors for `@opentui/*`.
4. GitHub Release (or workflow artifact) publishes the `.deb` for download without npm.

## Implementation notes (for plan)

- Do not commit `dist/` or staged `.deb-stage/` / Node tarballs; gitignore staging + `dist-packages/*.deb` if needed (or keep `dist-packages/` empty with `.gitkeep`).
- Update `README.md` + `AGENTS.md` with Linux `.deb` install instructions as the preferred path.
- Keep npm package publish path unchanged for non-Linux / existing users.
