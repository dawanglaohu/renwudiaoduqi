#!/usr/bin/env bash
# ==============================================================================
# Agent Scheduler Desktop Shell - Linux Launcher & Dependency Pre-Check
# Requirements: AC 3, AC 7, E-258, E-268
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_BIN="${SCRIPT_DIR}/../src-tauri/target/release/desktop_shell"

if [[ ! -x "${GUI_BIN}" ]]; then
  # Fallback to local sibling executable if installed
  if [[ -x "${SCRIPT_DIR}/desktop_shell" ]]; then
    GUI_BIN="${SCRIPT_DIR}/desktop_shell"
  fi
fi

# Detect Linux distribution ID
DISTRO_ID="unknown"
if [[ -f /etc/os-release ]]; then
  # shellcheck source=/dev/null
  DISTRO_ID="$(grep '^ID=' /etc/os-release | cut -d'=' -f2 | tr -d '"' | tr '[:upper:]' '[:lower:]')"
fi

# Function to probe for library files across standard linker paths
probe_library() {
  local lib_pattern="$1"
  if command -v ldconfig >/dev/null 2>&1; then
    if ldconfig -p 2>/dev/null | grep -E -q "${lib_pattern}"; then
      return 0
    fi
  fi

  local search_dirs=(
    "/usr/lib/x86_64-linux-gnu"
    "/usr/lib64"
    "/usr/lib"
    "/lib/x86_64-linux-gnu"
    "/lib64"
    "/lib"
    "/usr/local/lib"
  )

  for dir in "${search_dirs[@]}"; do
    if compgen -G "${dir}/${lib_pattern}" > /dev/null 2>&1; then
      return 0
    fi
  done

  return 1
}

HAS_WEBKIT=0
if probe_library "libwebkit2gtk-4.1.so*" || probe_library "libwebkit2gtk-4.0.so*"; then
  HAS_WEBKIT=1
fi

HAS_GTK3=0
if probe_library "libgtk-3.so*"; then
  HAS_GTK3=1
fi

if [[ ${HAS_WEBKIT} -eq 0 || ${HAS_GTK3} -eq 0 ]]; then
  echo "================================================================================" >&2
  echo "[ERROR] Missing required desktop system libraries for Desktop Shell (E-258)" >&2
  echo "================================================================================" >&2
  echo "The desktop GUI cannot initialize WebView without native WebKitGTK and GTK3." >&2
  echo "" >&2

  INSTALL_CMD=""
  case "${DISTRO_ID}" in
    ubuntu*|debian*|linuxmint*|pop*)
      INSTALL_CMD="sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0"
      ;;
    fedora*|rhel*|centos*|rocky*|alma*)
      INSTALL_CMD="sudo dnf install -y webkit2gtk4.1 gtk3"
      ;;
    arch*|manjaro*)
      INSTALL_CMD="sudo pacman -S --needed webkit2gtk-4.1 gtk3"
      ;;
    opensuse*|suse*)
      INSTALL_CMD="sudo zypper install -y libwebkit2gtk-4_1-0 libgtk-3-0"
      ;;
    *)
      INSTALL_CMD="Install webkit2gtk (4.1 or 4.0) and gtk3 packages using your system package manager."
      ;;
  esac

  echo "To install the missing dependencies on ${DISTRO_ID}, execute:" >&2
  echo "  ${INSTALL_CMD}" >&2
  echo "" >&2
  echo "After installation completes, re-run this launcher." >&2
  echo "================================================================================" >&2
  exit 1
fi

# Distribution compatibility check (AC 7, E-268)
if [[ "${DISTRO_ID}" != "ubuntu"* ]]; then
  echo "[NOTE] Desktop shell verified baseline is Ubuntu LTS (E-268)." >&2
  echo "       Distribution '${DISTRO_ID}' is supported on a best-effort basis." >&2
fi

if [[ -x "${GUI_BIN}" ]]; then
  exec "${GUI_BIN}" "$@"
else
  echo "[OK] Pre-flight dependency check passed: WebKitGTK and GTK3 are available."
  exit 0
fi
