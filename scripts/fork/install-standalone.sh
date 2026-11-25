#!/bin/sh
# Hemilake Studio on its own, without hemi: download the self-contained archive of a hemilake/studio release
# (its own Node, nothing else needed), check its sha256, unpack it under ~/.hemilake-studio and run it as a
# service of this user (a LaunchAgent on macOS, a systemd user unit on Linux) on http://127.0.0.1:8197.
# Studio's first-run setup then installs Claude Code, connects it to a model and connects the owner's Hemilake.
#
#   curl -fsSL https://raw.githubusercontent.com/hemilake/studio/main/scripts/fork/install-standalone.sh | sh
#
# Running it again updates to the latest release and keeps Studio's data (~/.cloudcli). Environment:
#   HEMILAKE_STUDIO_VERSION  a release such as 1.37.3-hemilake.13 (default: the latest)
#   HEMILAKE_STUDIO_PORT     the port on 127.0.0.1 (default 8197)
#   HEMILAKE_STUDIO_HOME     where it goes (default ~/.hemilake-studio)
#   HEMILAKE_STUDIO_SERVICE  0 to unpack only, without a service
# `sh install-standalone.sh --uninstall` stops and removes the service and the archives, never ~/.cloudcli.
set -eu

REPO=hemilake/studio
LABEL=com.hemilake.studio
PORT=${HEMILAKE_STUDIO_PORT:-8197}
DEST=${HEMILAKE_STUDIO_HOME:-$HOME/.hemilake-studio}
SERVICE=${HEMILAKE_STUDIO_SERVICE:-1}
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
UNIT=$HOME/.config/systemd/user/hemilake-studio.service

say() { printf '%s\n' "$*"; }
die() { printf 'hemilake-studio: %s\n' "$*" >&2; exit 1; }

os=$(uname -s)
case "$os" in
  Darwin) sys=darwin ;;
  Linux) sys=linux ;;
  *) die "this installer supports macOS and Linux, not $os" ;;
esac

stop_service() {
  if [ "$sys" = darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  else
    systemctl --user stop hemilake-studio.service >/dev/null 2>&1 || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_service
  if [ "$sys" = darwin ]; then rm -f "$PLIST"; else
    systemctl --user disable hemilake-studio.service >/dev/null 2>&1 || true
    rm -f "$UNIT"; systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$DEST"
  say "Hemilake Studio removed. Its data (account, projects, settings) stays in ~/.cloudcli."
  exit 0
fi

machine=$(uname -m)
case "$machine" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "no Studio build for $machine" ;;
esac
# Rosetta reports x86_64 to a translated shell on an Apple silicon Mac.
if [ "$sys" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
[ "$sys-$arch" != darwin-x64 ] || die "there is no Studio build for Intel Macs yet; it needs Apple silicon (M1 or newer)"

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 "$1" -o "$2"; }
else die "curl is needed"; fi
if command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
else die "shasum or sha256sum is needed"; fi

version=${HEMILAKE_STUDIO_VERSION:-}
if [ -z "$version" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$tag" ] || die "could not find the latest release of $REPO"
  version=${tag#v}
fi
name=hemilake-studio-$version-$sys-$arch
base=https://github.com/$REPO/releases/download/v$version

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
say "Downloading Hemilake Studio $version ($sys-$arch)…"
fetch "$base/$name.tar.xz" "$work/$name.tar.xz" || die "download failed: $base/$name.tar.xz"
fetch "$base/$name.tar.xz.sha256" "$work/sum" || die "download failed: $base/$name.tar.xz.sha256"
want=$(cut -d' ' -f1 < "$work/sum")
have=$(sha256 "$work/$name.tar.xz")
[ "$want" = "$have" ] || die "the archive does not match its sha256 ($have, expected $want); nothing was installed"

mkdir -p "$DEST/versions"
rm -rf "$DEST/versions/$version.tmp"
mkdir -p "$DEST/versions/$version.tmp"
tar -xJf "$work/$name.tar.xz" -C "$DEST/versions/$version.tmp"
[ -x "$DEST/versions/$version.tmp/$name/bin/hemilake-studio" ] || die "the archive has no bin/hemilake-studio"
rm -rf "$DEST/versions/$version"
mv "$DEST/versions/$version.tmp/$name" "$DEST/versions/$version"
rm -rf "$DEST/versions/$version.tmp"
ln -sfn "versions/$version" "$DEST/current.new" && mv -f "$DEST/current.new" "$DEST/current" 2>/dev/null \
  || { rm -f "$DEST/current"; ln -s "versions/$version" "$DEST/current"; }
# Keep this version and the one before it.
ls -1t "$DEST/versions" 2>/dev/null | tail -n +3 | while read -r old; do rm -rf "${DEST:?}/versions/$old"; done

launcher=$DEST/current/bin/hemilake-studio
if [ "$SERVICE" = 0 ]; then
  say "Unpacked. Run it with: HOST=127.0.0.1 SERVER_PORT=$PORT $launcher"
  exit 0
fi

# Claude Code's installer puts `claude` in ~/.local/bin; Homebrew in /opt/homebrew/bin or /usr/local/bin.
path="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
log=$DEST/studio.log
stop_service
if [ "$sys" = darwin ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$launcher</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>SERVER_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$path</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Hemilake Studio

[Service]
Environment=HOST=127.0.0.1 SERVER_PORT=$PORT PATH=$path
WorkingDirectory=$HOME
ExecStart=$launcher
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now hemilake-studio.service >/dev/null
fi

url=http://127.0.0.1:$PORT
i=0
until curl -fsS -o /dev/null "$url/" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || die "Studio did not answer on $url after a minute; its log is $log (macOS) or journalctl --user -u hemilake-studio"
  sleep 1
done
say "Hemilake Studio $version is running at $url"
say "It starts with your session. Run this installer again to update; add --uninstall to remove it."
if [ "$sys" = darwin ]; then open "$url" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi
