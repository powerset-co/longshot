#!/bin/bash
# Executed as root in a fresh Debian Sailbox. All project work runs as longshot.
set -euo pipefail
trap 'echo "Setup failed at line $LINENO: $BASH_COMMAND" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl tar gzip unzip git build-essential python3 python3-venv nodejs npm
id -u longshot >/dev/null 2>&1 || useradd --create-home --shell /bin/bash longshot
install -d -o longshot -g longshot /home/longshot/project /home/longshot/session
# Pin the executable and plugin; do not modify shell startup files.
curl -fsSL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.2.0.tgz -o /tmp/opencode.tgz
mkdir -p /opt/longshot/opencode
tar -xzf /tmp/opencode.tgz -C /opt/longshot/opencode
# The base image may already provide OpenCode. Replace its entry with our pinned
# executable; -n prevents following an existing symlink to a directory.
ln -sfn /opt/longshot/opencode/package/bin/opencode /usr/local/bin/opencode
# Linux prints "opencode v2.2.0"; some builds print just the version.
# Even --version creates OpenCode's temporary directory. Run it as the agent
# user so later tools can write there.
installed_version="$(runuser -u longshot -- opencode --version)"
if [[ "$installed_version" != "2.2.0" && "$installed_version" != "opencode v2.2.0" ]]; then
  echo "Expected OpenCode 2.2.0, got: $installed_version" >&2
  exit 1
fi
rm /tmp/opencode.tgz
