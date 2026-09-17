#!/usr/bin/env bash
# Installs the T3 Kimchi desktop app from the latest (or a pinned) GitHub
# Release, and puts a `t3-kimchi` launcher on PATH that reopens it.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/unprajjwal/t3-kimchi/main/scripts/install.sh | bash
#   T3KIMCHI_VERSION=v0.0.5 bash scripts/install.sh   # pin a specific release tag
set -euo pipefail

REPO="unprajjwal/t3-kimchi"
APP_ID="com.t3tools.t3code"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER="${BIN_DIR}/t3-kimchi"

log() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
[[ "$arch" == "aarch64" ]] && arch="arm64"
[[ "$arch" == "x86_64" ]] && arch="x64"

release_tag="${T3KIMCHI_VERSION:-latest}"
api_url="https://api.github.com/repos/${REPO}/releases/${release_tag}"
[[ "$release_tag" != "latest" ]] && api_url="https://api.github.com/repos/${REPO}/releases/tags/${release_tag}"

log "Looking up release ($release_tag) for $REPO..."
release_json="$(curl -fsSL "$api_url")" || die "could not reach GitHub releases API"
version="$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
[[ -n "$version" ]] || die "no release found for $REPO ($release_tag)"

find_asset() {
  # $1: grep pattern to match against browser_download_url
  printf '%s' "$release_json" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | sed -E 's/.*"([^"]+)"$/\1/' \
    | grep -m1 -E "$1" || true
}

case "$os" in
  Darwin)
    asset_url="$(find_asset "-${arch}\\.dmg$")"
    [[ -n "$asset_url" ]] || die "no macOS $arch .dmg found in release $version"

    tmp_dmg="$(mktemp -t t3kimchi).dmg"
    tmp_mount="$(mktemp -d -t t3kimchi-mount)"
    log "Downloading $(basename "$asset_url")..."
    curl -fsSL "$asset_url" -o "$tmp_dmg"

    log "Mounting disk image..."
    hdiutil attach -nobrowse -quiet -mountpoint "$tmp_mount" "$tmp_dmg"
    trap 'hdiutil detach "$tmp_mount" -quiet >/dev/null 2>&1 || true; rm -f "$tmp_dmg"; rmdir "$tmp_mount" 2>/dev/null || true' EXIT

    app_source="$(find "$tmp_mount" -maxdepth 1 -name '*.app' -print -quit)"
    [[ -n "$app_source" ]] || die "no .app bundle found inside downloaded dmg"
    app_name="$(basename "$app_source")"

    log "Installing ${app_name} to /Applications (may prompt for your password)..."
    rm -rf "/Applications/${app_name}"
    cp -R "$app_source" /Applications/

    mkdir -p "$BIN_DIR"
    cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Reopens the installed T3 Kimchi desktop app.
app_path="\$(mdfind "kMDItemCFBundleIdentifier == '${APP_ID}'" 2>/dev/null | head -n1)"
[[ -z "\$app_path" ]] && app_path="/Applications/${app_name}"
exec open -a "\$app_path"
EOF
    chmod +x "$LAUNCHER"

    log "Launching T3 Kimchi..."
    open -a "/Applications/${app_name}"
    ;;

  Linux)
    asset_url="$(find_asset "-${arch}\\.AppImage$")"
    [[ -n "$asset_url" ]] || die "no Linux $arch .AppImage found in release $version"

    install_dir="${HOME}/.local/share/t3-kimchi"
    mkdir -p "$install_dir" "$BIN_DIR"
    app_image="${install_dir}/T3Kimchi.AppImage"

    log "Downloading $(basename "$asset_url")..."
    curl -fsSL "$asset_url" -o "$app_image"
    chmod +x "$app_image"

    cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Reopens the installed T3 Kimchi desktop app.
exec "${app_image}" "\$@"
EOF
    chmod +x "$LAUNCHER"

    log "Launching T3 Kimchi..."
    nohup "$app_image" >/dev/null 2>&1 &
    disown
    ;;

  *)
    die "unsupported OS: $os (this installer covers macOS and Linux only)"
    ;;
esac

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) log "Add $BIN_DIR to your PATH to use the 't3-kimchi' command (e.g. add 'export PATH=\"$BIN_DIR:\$PATH\"' to your shell profile)." ;;
esac

log "Installed T3 Kimchi $version. Run 't3-kimchi' any time to reopen it."
