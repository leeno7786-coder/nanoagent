#!/usr/bin/env bash
# Build a self-contained amd64 .deb for NanoAgent (bundled Node 20 + deps).
# Usage: bash scripts/build-deb.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_VERSION="${NANOAGENT_NODE_VERSION:-20.19.4}"
NODE_ARCH="linux-x64"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
# From https://nodejs.org/dist/v20.19.4/SHASUMS256.txt
NODE_SHA256="${NANOAGENT_NODE_SHA256:-7a488a09e2fc02fbd1bc4ae084bea8a589314f741c182fc02c5f3f07c79a29d4}"

STAGE_ROOT="${ROOT}/.deb-stage"
STAGE="${STAGE_ROOT}/nanoagent"
OUT_DIR="${ROOT}/dist-packages"
CACHE_DIR="${ROOT}/.deb-cache"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: .deb packaging must run on Linux (got $(uname -s))" >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "error: v1 .deb is amd64-only (got $(uname -m))" >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "error: dpkg-deb not found (install dpkg)" >&2
  exit 1
fi

PKG_VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$PKG_VERSION" || "$PKG_VERSION" == "undefined" ]]; then
  echo "error: could not read version from package.json" >&2
  exit 1
fi

DEB_NAME="nanoagent_${PKG_VERSION}_amd64.deb"

echo "==> Building NanoAgent ${PKG_VERSION} amd64 .deb (Node ${NODE_VERSION})"

# --- app build ----------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  echo "==> bun install --frozen-lockfile"
  bun install --frozen-lockfile
else
  echo "==> bun not found; falling back to npm install"
  npm install
fi

echo "==> npm run build"
npm run build
test -f dist/main.js

# Production node_modules in an isolated tree so we don't strip the workspace.
PROD_DIR="${STAGE_ROOT}/prod-modules"
rm -rf "$PROD_DIR"
mkdir -p "$PROD_DIR"
cp package.json bun.lock "$PROD_DIR/"
# Keep optional platform packages (OpenTUI natives, bun linux bins if any).
# Ignore lifecycle scripts: postinstall tries to fetch bun and is not needed
# inside the .deb (we ship a bundled Node runtime instead).
if command -v bun >/dev/null 2>&1; then
  (
    cd "$PROD_DIR"
    bun install --frozen-lockfile --production --ignore-scripts
  )
else
  (
    cd "$PROD_DIR"
    npm install --omit=dev --ignore-scripts
  )
fi
test -d "$PROD_DIR/node_modules"

# Drop bun platform optionalDependencies — the .deb runs on bundled Node, not bun.
rm -rf \
  "${PROD_DIR}/node_modules/@oven" \
  "${PROD_DIR}/node_modules/bun"

# --- Node runtime -------------------------------------------------------------
mkdir -p "$CACHE_DIR"
NODE_CACHE="${CACHE_DIR}/${NODE_TARBALL}"
if [[ ! -f "$NODE_CACHE" ]]; then
  echo "==> Downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$NODE_CACHE"
fi
echo "==> Verifying Node tarball checksum"
echo "${NODE_SHA256}  ${NODE_CACHE}" | sha256sum -c -

# --- stage tree ---------------------------------------------------------------
rm -rf "$STAGE"
mkdir -p \
  "${STAGE}/DEBIAN" \
  "${STAGE}/usr/bin" \
  "${STAGE}/usr/lib/nanoagent"

echo "==> Staging application files"
cp -a dist "${STAGE}/usr/lib/nanoagent/"
cp -a skills "${STAGE}/usr/lib/nanoagent/"
mkdir -p "${STAGE}/usr/lib/nanoagent/scripts"
cp scripts/run-nanoagent.mjs "${STAGE}/usr/lib/nanoagent/scripts/"
cp package.json README.md LICENSE SECURITY.md AGENTS.md "${STAGE}/usr/lib/nanoagent/"
cp -a "${PROD_DIR}/node_modules" "${STAGE}/usr/lib/nanoagent/"

echo "==> Staging bundled Node ${NODE_VERSION}"
tar -xJf "$NODE_CACHE" -C "${STAGE}/usr/lib/nanoagent"
mv "${STAGE}/usr/lib/nanoagent/node-v${NODE_VERSION}-${NODE_ARCH}" \
  "${STAGE}/usr/lib/nanoagent/node"

# Drop Node docs/npm fluff we don't need at runtime (keeps the .deb smaller).
rm -rf \
  "${STAGE}/usr/lib/nanoagent/node/share" \
  "${STAGE}/usr/lib/nanoagent/node/lib/node_modules/npm" \
  "${STAGE}/usr/lib/nanoagent/node/lib/node_modules/corepack" \
  "${STAGE}/usr/lib/nanoagent/node/CHANGELOG.md" \
  "${STAGE}/usr/lib/nanoagent/node/README.md"
# Removing npm/corepack leaves dangling bin symlinks — drop those too.
rm -f \
  "${STAGE}/usr/lib/nanoagent/node/bin/npm" \
  "${STAGE}/usr/lib/nanoagent/node/bin/npx" \
  "${STAGE}/usr/lib/nanoagent/node/bin/corepack"

cat >"${STAGE}/usr/bin/nanogent" <<'EOF'
#!/bin/sh
exec /usr/lib/nanoagent/node/bin/node /usr/lib/nanoagent/scripts/run-nanoagent.mjs "$@"
EOF
cp "${STAGE}/usr/bin/nanogent" "${STAGE}/usr/bin/nanoagent"
chmod 0755 "${STAGE}/usr/bin/nanogent" "${STAGE}/usr/bin/nanoagent"
chmod 0755 "${STAGE}/usr/lib/nanoagent/node/bin/node"
chmod 0755 "${STAGE}/usr/lib/nanoagent/scripts/run-nanoagent.mjs"
chmod 0755 "${STAGE}/usr/lib/nanoagent/dist/main.js" 2>/dev/null || true

INSTALLED_SIZE="$(du -sk "${STAGE}/usr" | awk '{print $1}')"

cat >"${STAGE}/DEBIAN/control" <<EOF
Package: nanoagent
Version: ${PKG_VERSION}
Section: devel
Priority: optional
Architecture: amd64
Installed-Size: ${INSTALLED_SIZE}
Maintainer: leeno7786-coder <noreply@users.noreply.github.com>
Homepage: https://github.com/leeno7786-coder/nanoagent
Description: Ultra-lightweight CLI/TUI coding agent for local and cloud LLMs
 NanoAgent (nanogent) is a terminal coding agent optimized for small local
 models (LM Studio / Ollama) and cloud APIs. This package bundles a Node.js
 20 runtime and Linux dependencies so no separate npm/Node install is required.
EOF

# Ensure control scripts / dirs have Debian-friendly permissions.
find "${STAGE}/usr" -type d -exec chmod 0755 {} +
find "${STAGE}/usr" -type f -exec chmod a+r {} +
chmod 0755 "${STAGE}/usr/bin/nanogent" "${STAGE}/usr/bin/nanoagent"
# Only chmod real files (skip any leftover symlinks).
find "${STAGE}/usr/lib/nanoagent/node/bin" -type f -exec chmod 0755 {} +

mkdir -p "$OUT_DIR"
OUT_PATH="${OUT_DIR}/${DEB_NAME}"
rm -f "$OUT_PATH"

echo "==> Building ${OUT_PATH}"
# WSL/NTFS stages often land as 777; dpkg-deb requires 0755–0775 on DEBIAN/.
chmod 0755 "${STAGE}/DEBIAN"
find "${STAGE}/DEBIAN" -type f -exec chmod 0644 {} +
dpkg-deb --root-owner-group --build "$STAGE" "$OUT_PATH"

echo "==> Package info"
dpkg-deb -I "$OUT_PATH"
echo
ls -lh "$OUT_PATH"
echo
echo "Install with:  sudo apt install ./${DEB_NAME}"
echo "Or:            sudo dpkg -i ${OUT_PATH}"
