#!/bin/sh
# Release CI replaces @VERSION@ with the package version. The published script
# always downloads that exact release, even when fetched through /releases/latest.
set -eu

fail() { printf 'longshot: %s\n' "$*" >&2; exit 1; }

main() {
  version='@VERSION@'
  bin_dir="${HOME:?Set HOME or run this installer as your user}/.local/bin"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--bin-dir)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
        case "$1" in
          --version) version=${2#v} ;;
          --bin-dir) bin_dir=$2 ;;
        esac
        shift 2 ;;
      -h|--help)
        printf 'Usage: sh install.sh [--version VERSION] [--bin-dir DIRECTORY]\n'
        return ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
    fail 'Use a released installer, or specify --version (for example, 0.1.0).'

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail 'Supported operating systems: macOS and Linux.' ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail 'Supported architectures: ARM64 and x64.' ;;
  esac
  command -v curl >/dev/null 2>&1 || fail 'curl is required.'
  command -v tar >/dev/null 2>&1 || fail 'tar is required.'
  if command -v sha256sum >/dev/null 2>&1; then
    hash_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    hash_command=shasum
  else
    fail 'sha256sum or shasum is required to verify the download.'
  fi

  install_tmp=$(mktemp -d)
  install_staged=''
  # Interrupted downloads or installs leave the previous executable intact.
  trap 'rm -rf "$install_tmp"; if [ -n "$install_staged" ]; then rm -f "$install_staged"; fi' EXIT
  trap 'exit 1' HUP INT TERM
  asset="longshot-$os-$arch.tar.gz"
  url="https://github.com/powerset-co/longshot/releases/download/v$version"
  printf 'Downloading Longshot %s for %s/%s...\n' "$version" "$os" "$arch"
  curl -fsSL "$url/$asset" -o "$install_tmp/$asset"
  curl -fsSL "$url/SHA256SUMS" -o "$install_tmp/SHA256SUMS"
  expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$install_tmp/SHA256SUMS")
  printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "Missing or invalid checksum for $asset."
  if [ "$hash_command" = sha256sum ]; then
    actual=$(sha256sum "$install_tmp/$asset" | awk '{ print $1 }')
  else
    actual=$(shasum -a 256 "$install_tmp/$asset" | awk '{ print $1 }')
  fi
  [ "$actual" = "$expected" ] || fail 'Checksum mismatch; existing installation unchanged.'

  tar -xzf "$install_tmp/$asset" -C "$install_tmp" longshot
  [ -f "$install_tmp/longshot" ] && [ ! -L "$install_tmp/longshot" ] || fail 'Archive must contain a regular longshot executable.'
  chmod 755 "$install_tmp/longshot"
  installed_version=$(cd "$install_tmp" && ./longshot --version)
  [ "$installed_version" = "$version" ] || fail "Expected version $version, got $installed_version."

  mkdir -p "$bin_dir"
  [ ! -d "$bin_dir/longshot" ] || fail "$bin_dir/longshot is a directory."
  # Stage on the destination filesystem so the final rename is atomic.
  install_staged=$(mktemp "$bin_dir/.longshot.XXXXXX")
  cp "$install_tmp/longshot" "$install_staged"
  chmod 755 "$install_staged"
  mv -f "$install_staged" "$bin_dir/longshot"
  install_staged=''
  printf 'Installed Longshot %s to %s/longshot\n' "$version" "$bin_dir"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *)
      printf 'Add this directory to your PATH: %s\n' "$bin_dir"
      if [ "$bin_dir" = "$HOME/.local/bin" ]; then
        printf 'For this terminal, run:\n  export PATH="$HOME/.local/bin:$PATH"\n'
        printf 'Add that line to your shell profile to keep it for future terminals.\n'
      fi ;;
  esac
}

# Keep execution at the end so a truncated piped download does not start setup.
main "$@"
