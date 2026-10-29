# Longshot

A small CLI for long-running coding tasks. Give it a goal, let [OpenCode](https://opencode.ai) work in a [Sailbox](https://docs.sailresearch.com/sailbox-sdk) using Sail inference, and download the results when it's done.

**One directory, one run.** Longshot keeps resource IDs in `.longshot/run.json`. The agent runs remotely; your terminal can disconnect and re-attach later. There is no local daemon or global Longshot directory.

![Longshot starts a CSV CLI task, checks its progress, exports the code, and runs the generated tests.](docs/demo.gif)

An actual run, condensed for playback. Setup and inference waits are shortened.
[Read the demo](docs/demo.md) or [try its goal](examples/csv-summary/GOAL.md).

## Install

macOS and Linux, on ARM64 or x64:

```sh
curl -fsSL https://github.com/powerset-co/longshot/releases/latest/download/install.sh | sh
```

The installer downloads the matching release, verifies its SHA-256 checksum, and installs `longshot` in `~/.local/bin`. It prints PATH instructions if needed and does not edit your shell configuration. Run the same command again to upgrade.

The binary includes its runtime. You do not need Bun, Node, OpenCode, the Sail CLI, Docker, or Git installed locally. You only need a **Sail API key** to start a run.

To install a particular version or choose a different directory:

```sh
curl -fsSL https://github.com/powerset-co/longshot/releases/latest/download/install.sh | \
  sh -s -- --version 0.1.1 --bin-dir "$HOME/.local/bin"
```

You can also download an archive and checksums from [GitHub Releases](https://github.com/powerset-co/longshot/releases), extract it, and put the `longshot` executable on your PATH. For an unreleased checkout, see [building from source](#building-from-source).

## Usage

Set your key and move into the project you want the agent to work on:

```sh
export SAIL_API_KEY='your-key'
cd my-project
longshot start 'Build a Python CLI that summarizes CSV files as JSON. Add tests and run them.' --budget 10
```

For a longer specification, write it in `GOAL.md` and use `longshot start --file GOAL.md`. A budget is optional and estimates **inference only**; there is no budget by default. Sandbox compute is billed separately.

For a first run, copy the two files in [examples/csv-summary](examples/csv-summary) into an empty directory and run `longshot start --file GOAL.md --budget 2` there. Longshot uploads the current directory, so choose the project directory before starting.

`start` begins the project in a new Sailbox and returns once the remote goal is confirmed. You can close your terminal and check back later:

```sh
longshot status
longshot logs
longshot message 'Prioritize the failing integration tests.'
longshot attach
```

Initial setup installs OpenCode and development tools, so it can take a few minutes. Once started, the agent works independently of the local CLI. `status --json` and `logs --json` also let coding agents inspect and manage a run.

`logs` follows new events; Ctrl+C disconnects the reader. In `attach`, press Ctrl+X, then Q to detach. Both leave the remote goal running.

When the goal is complete and `status` shows execution is idle, download the result and stop the Sailbox charges:

```sh
longshot export --output ./result
longshot destroy --yes
```

Your project files are in `result/workspace`; session history and logs are in `result/session`. To stop a goal early, use `longshot pause`, then wait for execution to become idle before exporting. **Completion and pause leave the Sailbox running until you destroy it.**

To continue a paused goal, wait for `status` to show `Execution: idle`, then run `longshot resume`. Keep guidance messages until the resume command confirms the goal is active.

## Commands

| Command                                  | Behavior                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `start "goal"` / `start --file GOAL.md`  | Upload this directory and start a goal. Refuses an existing run record.                                                    |
| `status`                                 | Read sandbox health, persisted goal progress, usage, pending permissions/forms, and execution activity. No inference call. |
| `logs`                                   | Stream new text, reasoning, tool activity, and execution status. No history replay. Ctrl+C closes the reader only.         |
| `message "text"` / `message --file path` | Queue guidance in the existing session. Acceptance does not mean the agent has acted on it.                                |
| `attach`                                 | Open the remote OpenCode TUI in this terminal. Ctrl+X, then Q exits the TUI without stopping the server.                   |
| `pause`                                  | Pause goal continuation. An in-flight model/tool call may finish; compute remains running.                                 |
| `resume`                                 | Request goal continuation and verify its state. Does not reset or increase an exhausted token budget.                      |
| `export [--output path]`                 | Download the complete workspace and session data into a fresh directory.                                                   |
| `destroy --yes`                          | Terminate the Sailbox, delete this run's saved policy, then delete its inference secret. Preserve local state/exports.     |

All commands support `--directory path` (`-C`) and `--json`, except that `attach` requires a terminal and rejects `--json`. Without `--directory`, only the current directory is checked; parent directories are not searched.

`--json` emits a single JSON result for ordinary commands and one session event per line for `logs`. Progress and errors go to stderr. Errors have a nonzero exit status; a successful `status` query may describe an incomplete or paused goal. JSON errors have an `error` field. A disconnected log stream errors; rerun the command to reconnect.

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

Remove `setup` and `egressPolicyFile` if those files do not exist. CLI flags `--model`, `--window`, `--size`, and `--setup` override these values. Sizes are `s`, `m`, `l`; windows are `asap`, `balanced`, `flex`. Budget is supplied explicitly using `--budget`, never enabled by default.

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

## Approximate inference budgets

`--budget 50` converts $50 to a token limit for the goal plugin. It assumes 90% input and 10% output tokens, ignores cache discounts, and saves the rates and assumptions used at launch. Bundled rates are dated in `src/pricing.ts`. For another model, supply USD per million tokens in configuration:

```json
{ "pricing": { "input": 0.5, "output": 2.5 } }
```

This is a stopping aid, not a hard dollar cap. Actual input/output proportions, cache usage, auxiliary inference, and the final handoff change spending. A request can cross the token limit before the plugin stops continuation. Monitor your Sail charges. Sandbox compute is separate and continues after the goal stops.

Budgeted runs disable OpenCode subagent delegation because child-session accounting has not been verified against the parent goal's budget. Runs without a budget use the ordinary delegation permissions. Changing the model or configuration manually in an attached session can invalidate the estimate. There is no mid-run budget editing command.

The plugin has a separate 5,000-continuation ceiling and its normal no-progress/failure guards. An explicit resume can reopen an automatic-turn window; it does not reset token usage. No duration limit or VM expiry is imposed by Longshot.

## Files and recovery

Upload includes uncommitted and untracked files. It does not use `.gitignore`. Longshot excludes `.longshot`, `.git`, `node_modules`, `.DS_Store`, and `.env`/`.env.*` files at any depth, except `.env.example`, `.env.sample`, and `.env.template`. `exclude` adds Bun glob patterns relative to the working directory. Excluding a directory excludes its descendants. Relative symlinks within the upload are copied as links. Recursive links, links outside the project, absolute links, and links into excluded files are rejected before provisioning; copy their inputs into the project or explicitly exclude those links.

Export does not use Git or apply upload exclusions. The output contains:

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
5. `src/state.ts` and `src/pricing.ts`: local files and budget estimation.
6. `src/guest-setup.sh`: the guest's OS/runtime setup.

The two runtime dependencies are Sail's SDK and citty. Citty generates help from the command definitions; a small validation step uses Bun's `node:util.parseArgs` to reject unknown flags and extra arguments before dispatch. Run `longshot --help` or `longshot start --help` for usage. OpenCode **2.2.0**, goal plugin **0.1.84**, and Sail SDK **0.17.1** are pinned. The standalone binary is built on each target OS/architecture so the SDK's native library is bundled correctly.

The local tests cover boundaries where a mistake could lose work, expose files, or start an unintended run: exclusive run creation, recovery IDs, upload filtering and links, cleanup ordering, budget conversion, event framing, and CLI help/errors. They use temporary directories and mocked Sail operations; they do not create cloud resources. CLI tests also check that misspelled flags fail before provisioning and that JSON output remains usable by agents. Installer tests run the actual setup shell in a temporary filesystem, including replacement of a preinstalled executable and both OpenCode version-output formats.

## Publishing a release

Release assets live in [powerset-co/longshot](https://github.com/powerset-co/longshot/releases).

1. Update `version` in `package.json`, commit the release changes, and push the commit.
2. Push the matching tag, for example:

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. GitHub Actions checks that the tag matches `package.json`, runs the tests, builds macOS/Linux ARM64/x64 archives, and tests each extracted binary outside the checkout without `node_modules`.
4. The workflow creates a **draft** release containing the four archives, `SHA256SUMS`, and `install.sh`. The installer is pinned to that release's version. Tags containing a prerelease suffix, such as `v0.2.0-rc.1`, produce prereleases.
5. Review the draft and publish it. The README's latest-release installer URL then serves the latest stable release.

Before publishing, run a small real Sail goal and verify startup, inference credential injection, status, logs, attach, pause/resume, export, and destruction. Local tests do not validate Sail networking or billing. Test the downloaded installer and binary on a clean machine as well; GitHub-hosted builds alone do not establish compatibility with every OS version.

The installer uses only standard shell tools (`curl`, `tar`, and `sha256sum` or `shasum`). Installer tests use local archives to verify platform selection, version selection, checksums, and preservation of an existing binary on failure. They do not download releases or touch your installed copy.

MIT licensed.
