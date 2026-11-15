#!/usr/bin/env bash
set -Eeuo pipefail

# Matshell Niri installer. This script never enables autostart and never
# overwrites an existing AGS configuration.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/ags"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

if [[ ! -f "$SCRIPT_DIR/app.ts" || ! -d "$SCRIPT_DIR/widgets" ]]; then
  echo "Run this script from a cloned matshell-niri repository."
  exit 2
fi

if [[ ! -f /etc/arch-release && ! -f /etc/cachyos-release && ! -x "$(command -v pacman 2>/dev/null || true)" ]]; then
  echo "Automatic dependency installation currently supports Arch-based systems."
  echo "Install the dependencies listed in README.md manually, then rerun with --check."
  exit 2
fi

if [[ -z "${NIRI_SOCKET:-}" ]]; then
  echo "Warning: NIRI_SOCKET is not set. The installer is designed for a Niri session."
fi

# Packages required by Matshell's current Astal imports and runtime.
PACKAGES=(
  libastal-4-git
  libastal-io-git
  libastal-apps-git
  libastal-battery-git
  libastal-bluetooth-git
  libastal-cava-git
  libastal-mpris-git
  libastal-network-git
  libastal-notifd-git
  libastal-powerprofiles-git
  libastal-tray-git
  libastal-wireplumber-git
  libgtop libadwaita libsoup3 glib-networking
  gtk4 gtk4-layer-shell dart-sass matugen-bin
  cliphist wl-clipboard imagemagick networkmanager wireplumber
  adwaita-icon-theme ttf-material-symbols-variable-git ttf-firacode-nerd
)

GI_NAMES=(Astal-4.0 AstalIO- AstalApps- AstalBattery- AstalBluetooth- AstalCava- AstalMpris- AstalNetwork- AstalNotifd- AstalPowerProfiles- AstalTray- AstalWp-)

missing_packages=()
for package in "${PACKAGES[@]}"; do
  pacman -Q "$package" >/dev/null 2>&1 || missing_packages+=("$package")
done
command -v ags >/dev/null 2>&1 || missing_packages+=("aylurs-gtk-shell-git")

missing_commands=()
for command_name in ags sass matugen; do
  command -v "$command_name" >/dev/null 2>&1 || missing_commands+=("$command_name")
done

missing_gi=()
GI_DIR="${GI_TYPELIB_PATH:-/usr/lib/girepository-1.0}"
for namespace in "${GI_NAMES[@]}"; do
  compgen -G "$GI_DIR/${namespace}*.typelib" >/dev/null || missing_gi+=("$namespace")
done

report_status() {
  echo "Matshell Niri dependency check"
  echo "------------------------------"
  if ((${#missing_packages[@]})); then
    printf 'Missing packages: %s\n' "${missing_packages[*]}"
  else
    echo "Package dependencies: OK"
  fi
  if ((${#missing_commands[@]})); then
    printf 'Missing commands: %s\n' "${missing_commands[*]}"
  else
    echo "Required commands: OK"
  fi
  if ((${#missing_gi[@]})); then
    printf 'Missing GI typelibs: %s\n' "${missing_gi[*]}"
  else
    echo "Astal GI typelibs: OK"
  fi
}

report_status

if ((${#missing_packages[@]} || ${#missing_commands[@]} || ${#missing_gi[@]})); then
  if ((CHECK_ONLY)); then
    exit 1
  fi
  if ! command -v yay >/dev/null 2>&1; then
    echo "\nyay is required to install missing AUR dependencies. No files were changed."
    exit 1
  fi
  echo
  read -r -p "Install missing packages with yay? [y/N] " answer
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *) echo "Cancelled. No files were changed."; exit 1 ;;
  esac
  yay -S --needed "${missing_packages[@]}"

  # Recheck after package installation.
  missing_commands=()
  for command_name in ags sass matugen; do
    command -v "$command_name" >/dev/null 2>&1 || missing_commands+=("$command_name")
  done
  missing_gi=()
  for namespace in "${GI_NAMES[@]}"; do
    compgen -G "$GI_DIR/${namespace}*.typelib" >/dev/null || missing_gi+=("$namespace")
  done
  if ((${#missing_commands[@]} || ${#missing_gi[@]})); then
    echo "Dependencies are still missing after installation. See the report above."
    exit 1
  fi
fi

if [[ -e "$DEST" ]] && [[ -n "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo
  echo "Refusing to overwrite existing configuration: $DEST"
  echo "Move it aside manually if you want a fresh Matshell install."
  exit 1
fi

mkdir -p "$DEST"
tar --exclude='./.git' --exclude='./node_modules' -cf - -C "$SCRIPT_DIR" . | tar -xf - -C "$DEST"

printf '\nMatshell Niri files installed to: %s\n' "$DEST"
echo "No autostart entry was created and no running shell was stopped."
echo "Test manually with: cd '$DEST' && ags run ./app.ts"
echo "Run this installer with --check to verify dependencies without changing files."
