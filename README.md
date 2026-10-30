# Longshot

A tiny CLI for managing long-running, goal-based, coding tasks on [Sailboxes](https://docs.sailresearch.com/sailbox-sdk), using [Sail inference](https://sailresearch.com) and [OpenCode](https://opencode.ai) in [goal mode](https://x.com/Neriousy/status/2115790892678434965).

**One directory, one run.** Longshot keeps resource IDs in `.longshot/run.json`. The agent runs remotely; your terminal can disconnect and re-attach later. There is no local daemon or global Longshot directory.

## Install

macOS and Linux, on ARM64 or x64:

```sh
curl -fsSL https://github.com/powerset-co/longshot/releases/latest/download/install.sh | sh
```

The installer downloads the matching release, verifies its SHA-256 checksum, and installs `longshot` in `~/.local/bin`. It prints PATH instructions if needed and does not edit your shell configuration. Run the same command again to upgrade.

The binary includes its runtime. You do not need Bun, Node, OpenCode, the Sail CLI, Docker, or Git installed locally. You only need a **[Sail API key](https://app.sailresearch.com)** to start a run.

To install a particular version or choose a different directory:

```sh
curl -fsSL https://github.com/powerset-co/longshot/releases/latest/download/install.sh | \
  sh -s -- --version 0.1.0 --bin-dir "$HOME/.local/bin"
```

You can also download an archive and checksums from [GitHub Releases](https://github.com/powerset-co/longshot/releases), extract it, and put the `longshot` executable on your PATH. For an unreleased checkout, see [building from source](#building-from-source). The installer URL is available once the first release is published.

## Usage

Set your key and move into the project you want the agent to work on:

```sh
export SAIL_API_KEY='your-key'
cd my-project
longshot start 'Build a simple Go CLI that prints the first 10000 fibonacci numbers.'
```

For a longer specification, write it in `GOAL.md` and use `longshot start --file GOAL.md`. Longshot does not enforce a spending limit. You are responsible for monitoring inference and Sailbox compute charges and stopping the run when needed.

`start` begins the project in a new Sailbox and returns once the remote goal is confirmed. The full specification is saved to `/home/longshot/session/goal.md`; a short native objective references that file, so long specifications are not truncated to OpenCode's 4,000-character objective limit. You can close your terminal and check back later:

```sh
longshot status
longshot logs
longshot message 'Prioritize the failing integration tests.'
longshot attach
```

`logs` follows new events; Ctrl+C disconnects the reader. In `attach`, press Ctrl+X, then Q to detach. Both leave the remote goal running.

When the goal is complete and `status` shows execution is idle, download the result and stop the Sailbox charges:

```sh
longshot export --output ./result
longshot destroy --yes
```

Your project files are in `result/workspace`; session history and logs are in `result/session`. To stop a goal early, use `longshot pause`, then wait for execution to become idle before exporting. **Completion and pause leave the Sailbox running until you destroy it.**

## Commands

| Command                                  | Behavior                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `start "goal"` / `start --file GOAL.md`  | Upload this directory and start a goal. Refuses an existing run record.                                                    |
| `status`                                 | Read sandbox health, goal progress, recent activity, pending permissions/forms, and execution activity. No inference call. |
| `logs`                                   | Stream new text, reasoning, tool activity, and execution status. No history replay. Ctrl+C closes the reader only.         |
| `message "text"` / `message --file path` | Queue guidance in the existing session. Acceptance does not mean the agent has acted on it.                                |
| `attach`                                 | Open the remote OpenCode TUI in this terminal. Ctrl+X, then Q exits the TUI without stopping the server.                   |
| `pause`                                  | Pause goal continuation. An in-flight model/tool call may finish; compute remains running.                                 |
| `resume`                                 | Resume goal continuation with a fresh 50-round allowance.                                                                  |
| `export [--output path]`                 | Download the complete workspace and session data into a fresh directory.                                                   |
| `destroy --yes`                          | Terminate the Sailbox, delete this run's saved policy, then delete its inference secret. Preserve local state/exports.     |

All commands support `--directory path` (`-C`) and `--json`, except that `attach` requires a terminal and rejects `--json`. Without `--directory`, only the current directory is checked; parent directories are not searched.

`--json` emits a single JSON result for ordinary commands and one session event per line for `logs`. Progress and errors go to stderr. In an interactive terminal, `start` shows the current stage, a spinner, elapsed time, and the latest three installation/setup log lines. Successful stages collapse to a checkmark; failures leave recent output visible. With `--json` or redirected stderr, startup streams the full output without animation. Stdout stays reserved for the final result. `start` returns once the remote goal is confirmed. Errors have a nonzero exit status; a successful `status` query may describe an incomplete or paused goal. JSON errors have an `error` field. A disconnected log stream errors; rerun the command to reconnect.

Pausing controls the **goal**, not the VM. If you pause the entire VM through Sail, resume it through Sail before using commands that need guest access. `destroy` works on a paused box. A shared Sail app named `longshot` groups resources; the app is retained after cleanup and is not a local run registry.

## Configuration

Everything is optional. Put `longshot.json` in the working directory:

```json
{
  "model": "zai-org/GLM-5.3",
  "window": "balanced",
  "size": "m",
  "visibility": "org",
  "setup": "setup.sh",
  "env": { "CI": "true" },
  "exclude": ["**/dist", "**/.venv"],
  "egressPolicyFile": "egress.json"
}
```

Remove `setup` and `egressPolicyFile` if those files do not exist. CLI flags `--model`, `--window`, `--size`, and `--setup` override these values. Sizes are `s`, `m`, `l`; windows are `asap`, `balanced`, `flex`.

The guest is an AMD64 Debian Sailbox with Git, curl, archive tools, a C/C++ toolchain, Python, Node, npm, and pinned OpenCode. Project files live in `/home/longshot/project`; OpenCode runs as the ordinary `longshot` user. A setup script runs there before inference, with a 20-minute timeout. Install language-specific tools/dependencies into the user's home or workspace. The configured `env` is passed to setup and OpenCode; host environment variables are not forwarded.

The generated OpenCode configuration uses Build mode and allows coding tools without approval prompts. The interactive question tool is denied so an unattended run can report a blocker instead of waiting for terminal input. Treat project configuration, plugins, skills, and setup scripts as executable input. This is a remote coding environment, not an additional permission system for actions authorized by supplied credentials.

`visibility: "org"` uses Sail's organization access semantics and works with organization API keys. Choose `"private"` with a user-scoped Sail key to restrict the box to its creator. See [Sail access control](https://docs.sailresearch.com/sailboxes-access-control).

## Secrets

The Sail API key stays on the local machine and in a uniquely named Sail Secret. A saved egress policy injects it only into `POST https://api.sailresearch.com/v1/chat/completions`. OpenCode receives a placeholder credential, not the real key. Longshot does not save the key in `run.json` or upload the local environment.

Additional credentials use existing Sail Secrets and Sail's native egress policy format:

```json
{
  "rules": {
    "api.example.com": [
      {
        "request": { "set": { "headers": { "authorization": "Bearer ${secrets.EXAMPLE_TOKEN}" } } }
      }
    ]
  }
}
```

Point `egressPolicyFile` at that JSON file. Longshot saves a new per-run policy with those rules plus its own inference rule. Additional rules must use exact hosts other than `api.sailresearch.com`. Existing secrets are referenced, never replaced or deleted. Optional allowlists must permit installation/package-download hosts. Without an allowlist the guest can access the internet.

Sail credential injection applies to HTTPS headers/query parameters; it does **not** materialize secret-valued environment variables. `env` is for non-secret configuration and appears in run state and exports. [Sail credential documentation](https://docs.sailresearch.com/sailboxes-credentials)

## Monitoring costs

Monitor inference and compute charges through [Sail](https://app.sailresearch.com). Use `longshot pause` to pause goal continuation; an in-flight call may finish. Sailbox compute continues after a goal pauses or completes. Export your results, then use `longshot destroy --yes` to remove the remote resources.

OpenCode's native [goal mode](https://x.com/Neriousy/status/2115790892678434965) reviews progress whenever the session would finish. It continues until the reviewer confirms completion, or pauses because it needs help, encounters an error, stops making progress, or reaches 50 continuation rounds. `longshot resume` starts a fresh round allowance. A server restart also pauses an active goal. `status` reports the current state, round count, and latest goal update (reviewer feedback or a pause/error reason). It also reads up to three recent assistant messages to show a short text, reasoning, or tool activity excerpt. `Recorded` is OpenCode's timestamp for that activity, not the time you polled; an in-flight response may still show its start time. `--json` includes this as `activity` with `type`, `summary`, and `recordedAt` (Unix milliseconds), or `null` before output is available. These reads make no inference requests. `logs` includes goal-state changes. The reviewer makes additional inference requests using the same Sail model.

`status` also shows `Elapsed`, measured from OpenCode session creation. It excludes Sailbox setup, includes pauses and waiting time, and freezes at the goal's completion timestamp. This is wall-clock time, not active inference time. JSON output includes `elapsedMs`, or `null` when session timing is unavailable.

Longshot does not impose a spending limit, duration limit, or VM expiry. Native goal status does not include token usage or dollar estimates; monitor those through Sail.

The former `--budget` flag and `pricing` configuration are no longer supported. Remove `pricing` from `longshot.json` before starting a new run. Existing remote sessions retain any token limits configured when they launched.

## Files and recovery

Runs created with the external goal plugin are not migrated. Use their original Longshot binary for `status`, `pause`, `resume`, and `export`. The new binary can still `attach`, stream `logs`, send a `message`, or `destroy` those runs. Start a fresh run to use native goal mode.

Upload includes uncommitted and untracked files. It does not use `.gitignore`. Longshot excludes `.longshot`, `.git`, `node_modules`, `.DS_Store`, and `.env`/`.env.*` files at any depth, except `.env.example`, `.env.sample`, and `.env.template`. `exclude` adds Bun glob patterns relative to the working directory. Excluding a directory excludes its descendants. Relative symlinks within the upload are copied as links. Recursive links, links outside the project, absolute links, and links into excluded files are rejected before provisioning; copy their inputs into the project or explicitly exclude those links.

Export does not use Git or apply upload exclusions. A temporary guest copy converts absolute symlinks within each exported tree to relative links (including Bun cache links). Links outside that tree remain subject to Sail's archive safety checks. The temporary copy is removed after download; the live files are unchanged. The output contains:

```text
export/
  workspace/     # Every file in the remote project, including hidden/build/ignored files.
  session/       # Goal state, OpenCode data, logs, configuration, and caches.
  run.json       # Launch settings and IDs.
```

This exports the workspace/session trees, not the operating system or virtual filesystems such as `/proc`. Wait for the goal and background file writers to finish. Longshot refuses export while the goal/session is running and uses SQLite's backup API for the OpenCode database. Other files are ordinary copies, not an atomic VM snapshot. Export refuses an existing destination; a `.partial` marker remains if interrupted. An export does not destroy the Sailbox.

Startup saves IDs after each cloud operation. A failed launch preserves resources and its run record. Use `status` and `destroy --yes`; do not delete `.longshot` to retry while its resources still exist. If a creation response was lost, destruction reconciles the exact unique run name before cleanup. It never retries creation blindly. Export results before destruction. Start a separate run in a separate directory.

Exports contain project data, ordinary configured environment values, and a localhost OpenCode password; keep them private. Credentials written by the user's code are also files and are included in the complete workspace export.

## Building from source

With [Bun](https://bun.sh) installed (tested with 1.3.2):

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
./dist/longshot --help
```

The standalone executable is `dist/longshot`. Build on the target OS/architecture so the Sail SDK's native library is bundled correctly.

## Reading and developing the code

Run `bun run format` to format the repository, or `bun run format:check` to check formatting without changing files. CI checks formatting before running the tests.

Read the modules in this order:

1. `src/cli.ts`: command definitions, generated help, and dispatch.
2. `src/run.ts`: the linear launch sequence and commands.
3. `src/sail.ts`: cloud operations, credential policy, and cleanup.
4. `src/opencode.ts`: generated config, localhost HTTP calls, goal state, live events.
5. `src/state.ts`: local configuration, run records, and upload staging.
6. `src/guest-setup.sh`: the guest's OS/runtime setup.
7. `src/progress.ts`: the compact startup display and plain-output fallback.

The two runtime dependencies are [Sail's SDK](https://docs.sailresearch.com/sailbox-sdk) and citty. Citty generates help from the command definitions; a small validation step uses Bun's `node:util.parseArgs` to reject unknown flags and extra arguments before dispatch. Run `longshot --help` or `longshot start --help` for usage. [OpenCode **2.2.1**](https://github.com/anomalyco/opencode/releases/tag/v2.2.1) and Sail SDK **0.17.1** are pinned. Goal mode is built into OpenCode; no external goal plugin is installed. The standalone binary is built on each target OS/architecture so the SDK's native library is bundled correctly.

The local tests cover boundaries where a mistake could lose work, expose files, or start an unintended run: exclusive run creation, recovery IDs, upload filtering and links, cleanup ordering, native goal API calls, pause/export guards, event framing, and CLI help/errors. They use temporary directories and mocked Sail operations; they do not create cloud resources. CLI tests also check that misspelled flags fail before provisioning and that JSON output remains usable by agents. Installer tests run the actual setup shell in a temporary filesystem, including replacement of a preinstalled executable and both OpenCode version-output formats.

## Publishing a release

Release assets live in [powerset-co/longshot](https://github.com/powerset-co/longshot/releases).

1. Update `version` in `package.json`, commit the release changes, and push the commit.
2. Push the matching tag, for example:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. GitHub Actions checks that the tag matches `package.json`, runs the tests, builds macOS/Linux ARM64/x64 archives, and tests each extracted binary outside the checkout without `node_modules`.
4. The workflow creates a **draft** release containing the four archives, `SHA256SUMS`, and `install.sh`. The installer is pinned to that release's version. Tags containing a prerelease suffix, such as `v0.2.0-rc.1`, produce prereleases.
5. Review the draft and publish it. The README's latest-release installer URL then serves the latest stable release.

Before publishing, run a small real Sail goal and verify startup, inference credential injection, status, logs, attach, pause/resume, export, and destruction. Local tests do not validate Sail networking or billing. Test the downloaded installer and binary on a clean machine as well; GitHub-hosted builds alone do not establish compatibility with every OS version.

The installer uses only standard shell tools (`curl`, `tar`, and `sha256sum` or `shasum`). Installer tests use local archives to verify platform selection, version selection, checksums, and preservation of an existing binary on failure. They do not download releases or touch your installed copy.

MIT licensed.
