# Linux amd64 `.deb` Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained amd64 `.deb` (bundled Node 20 + linux-x64 deps + prebuilt `dist/`) installable without npm.

**Architecture:** Stage a Debian filesystem tree under `.deb-stage/`, populate it via `scripts/build-deb.sh`, and pack with `dpkg-deb`. CI builds the artifact on tag / workflow_dispatch and attaches it to GitHub Releases.

**Tech Stack:** bash, `dpkg-deb`, bun/npm, official Node linux-x64 tarball, GitHub Actions

## Global Constraints

- Architecture: amd64 only (v1)
- Bundle Node 20.x linux-x64 (no `Depends: nodejs`)
- Layout: `/usr/lib/nanoagent/{dist,node_modules,skills,node,package.json}`, bins `/usr/bin/nanogent` + `/usr/bin/nanoagent`
- Do not commit `dist/`, `.deb-stage/`, Node tarballs, or built `.deb` binaries
- Prefer `bun install --frozen-lockfile`; keep npm publish path working

---

### Task 1: `scripts/build-deb.sh` + npm script + gitignore

**Files:**
- Create: `scripts/build-deb.sh`
- Modify: `package.json` (add `package:deb`)
- Modify: `.gitignore` (`.deb-stage/`, `dist-packages/`)

- [x] Implement stage/build/pack script (Node pin + sha256, prod node_modules, wrappers, control)
- [x] Add `"package:deb": "bash scripts/build-deb.sh"`
- [x] Gitignore staging + output dirs
- [x] Run script locally; verify `dpkg-deb -I` / `dpkg-deb -c` and `nanogent --help` via staged tree
- [x] Commit

### Task 2: CI workflow + release attachment

**Files:**
- Create: `.github/workflows/package-deb.yml` (workflow_dispatch + tags)
- Modify: `.github/workflows/release.yml` (attach `.deb` to GitHub Release)

- [x] Add workflow that runs `package:deb` and uploads artifact
- [x] On `v*` tags, attach `.deb` alongside npm tarball on the Release
- [x] Commit

### Task 3: Docs

**Files:**
- Modify: `README.md` (Linux `.deb` as recommended Linux install)
- Modify: `AGENTS.md` (package:deb command + preferred Linux path)

- [x] Document download/install/remove
- [x] Commit, push, open/update PR
