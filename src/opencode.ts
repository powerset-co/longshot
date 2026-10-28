// OpenCode listens only inside the Sailbox. HTTP requests travel through Sail
// exec + guest curl; there is no public server, local proxy, or background daemon.
import type { Sailbox } from "@sailresearch/sdk";
import type { Run } from "./state.ts";
import { command, home, project, quote, session, user } from "./sail.ts";

export interface Goal {
  status: string;
  objective: string;
  tokensUsed: number;
  tokenBudget: number | null;
  autoTurns: number;
  timeUsedSeconds: number;
  stopReason?: string | null;
  lastCheckpoint?: { summary: string; timestamp: number } | null;
  [key: string]: unknown;
}
export function configuration(
  run: Run,
  plugin = `@prevalentware/opencode-goal-plugin@${run.versions.goal}`,
) {
  return {
    model: "sail/coder",
    snapshots: false,
    providers: {
      sail: {
        name: "Sail",
        env: ["SAIL_INFERENCE_PLACEHOLDER"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.sailresearch.com/v1", headerTimeout: 900_000 },
        body: { metadata: { completion_window: run.config.window } },
        models: {
          coder: {
            modelID: run.config.model,
            name: run.config.model,
            limit: { context: 131_072, output: 16_384 },
          },
        },
      },
    },
    plugins: [
      {
        package: plugin,
        options: {
          auto_continue: true,
          max_auto_turns: 5000,
          ...(run.budget ? { default_token_budget: run.budget.tokens } : {}),
        },
      },
    ],
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      // A headless question otherwise waits indefinitely. The goal can report a blocker.
      { action: "question", resource: "*", effect: "deny" },
      // Child-session usage is not proven to be included in goal accounting.
      ...(run.budget ? [{ action: "subagent", resource: "*", effect: "deny" }] : []),
    ],
  };
}

export async function prepare(box: Sailbox, run: Run) {
  const password = crypto.randomUUID();
  const config = configuration(run);
  const env = {
    ...run.config.env,
    HOME: home,
    XDG_CONFIG_HOME: `${session}/config`,
    XDG_DATA_HOME: `${session}/data`,
    XDG_CACHE_HOME: `${session}/cache`,
    XDG_STATE_HOME: `${session}/state`,
    OPENCODE_DB: `${session}/opencode.db`,
    OPENCODE_GOAL_STATE_PATH: `${session}/goals.json`,
    OPENCODE_PASSWORD: password,
    SAIL_INFERENCE_PLACEHOLDER: "injected-by-sail",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  await box.fs.write(`${session}/config/opencode/opencode.json`, JSON.stringify(config), {
    user,
    mode: 0o600,
  });
  await box.fs.write(
    `${session}/config/opencode/cli.json`,
    JSON.stringify({ plugins: [`@prevalentware/opencode-goal-plugin@${run.versions.goal}`] }),
    { user },
  );
  // A remote wrapper gives server, installer, and attached TUI identical paths.
  // Its credential is only for localhost OpenCode, never the Sail API key.
  const wrapper =
    "#!/bin/bash\nset -e\n" +
    Object.entries(env)
      .map(([k, v]) => `export ${k}=${quote(v)}`)
      .join("\n") +
    '\nexec opencode "$@"\n';
  await box.fs.write(`${session}/opencode`, wrapper, { user, mode: 0o700 });
  await box.fs.write(`${session}/curl.conf`, `user = "opencode:${password}"\n`, {
    user,
    mode: 0o600,
  });
  // Install both entrypoints before starting the server (including the TUI plugin).
  await command(
    box,
    [
      `${session}/opencode`,
      "plugin",
      "add",
      `@prevalentware/opencode-goal-plugin@${run.versions.goal}`,
    ],
    user,
    600,
  );
  const launch = await box.exec(
    `${quote(session + "/opencode")} serve --hostname 127.0.0.1 --port 4096 >${quote(session + "/server.log")} 2>&1`,
    { user, cwd: project, background: true },
  );
  try {
    const result = await launch.wait();
    if (result.exitCode !== 0) throw new Error("OpenCode launch failed.");
  } finally {
    launch.close();
  }
  const location = `?location%5Bdirectory%5D=${encodeURIComponent(project)}`;
  await until(
    async () => {
      try {
        await api(box, "/api/info");
        const commands = await api<{ data: { name: string }[] }>(box, "/api/command" + location);
        const plugins = await api<{ data: { id: string; state?: { status: string } }[] }>(
          box,
          "/api/plugin" + location,
        );
        return (
          commands.data.some((x) => x.name === "goal") &&
          plugins.data.some(
            (x) => x.id === "local.goal-mode.server" && x.state?.status === "active",
          )
        );
      } catch {
        return false;
      }
    },
    "OpenCode/plugin did not become ready. Inspect the exported session/server.log.",
    120_000,
  );
}

function curlArgs(path: string) {
  return [
    "curl",
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--config",
    `${session}/curl.conf`,
    `http://127.0.0.1:4096${path}`,
  ];
}
export async function api<T = unknown>(box: Sailbox, path: string, body?: unknown): Promise<T> {
  // Send JSON over stdin, not through shell interpolation. Drain both output
  // streams while waiting so large responses cannot deadlock the exec pipe.
  const args = [...curlArgs(path), "--max-time", "30"];
  if (body !== undefined)
    args.push("--header", "Content-Type: application/json", "--data-binary", "@-");
  const proc = await box.exec(args, {
    user,
    openStdin: body !== undefined,
    timeoutSeconds: 40,
    outputMode: "pipe",
  });
  try {
    const send = async () => {
      if (body !== undefined) {
        await proc.writeStdin(JSON.stringify(body));
        await proc.closeStdin();
      }
    };
    const [out, err, result] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.wait(),
      send(),
    ]);
    if (result.exitCode !== 0) throw new Error(`OpenCode request failed: ${err || out}`);
    return (out ? JSON.parse(out) : undefined) as T;
  } finally {
    proc.close();
  }
}
// The plugin persists progress after each turn. Reading this file costs no
// inference and works independently of the running model request.
export async function goal(box: Sailbox, id: string): Promise<Goal | null> {
  if (!(await box.fs.exists(`${session}/goals.json`))) return null;
  const state = JSON.parse(Buffer.from(await box.fs.read(`${session}/goals.json`)).toString());
  if (![1, 2, 3].includes(state.version)) throw new Error("Unsupported goal state format.");
  return state.goals?.[id] ?? null;
}
export async function until(
  check: () => Promise<boolean>,
  failure: string,
  milliseconds = 300_000,
) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await check()) return;
    await Bun.sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(failure);
}

// SSE boundaries can split anywhere in an exec chunk, including between CR/LF.
// This deliberately has no event store, cursor, replay, or reconnect logic.
export async function* events(chunks: AsyncIterable<string>): AsyncGenerator<any> {
  let pending = "";
  for await (const chunk of chunks) {
    pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield JSON.parse(data);
    }
    if (pending.length > 8 * 1024 * 1024) throw new Error("OpenCode event exceeded 8 MiB.");
  }
}
export async function logs(box: Sailbox, id: string, json: boolean) {
  console.error("Following new session events (no history replay). Ctrl+C to disconnect.");
  const proc = await box.exec([...curlArgs("/api/event"), "--no-buffer"], { user });
  let stopped = false;
  const stop = () => {
    stopped = true;
    void proc.cancel({ force: true }).catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const stderr = proc.stderr.text().catch((error) => String(error));
  try {
    for await (const event of events(proc.stdout)) {
      if (event.data?.sessionID !== id) continue;
      if (json) console.log(JSON.stringify(event));
      // Models can spend minutes emitting only reasoning. Include that stream
      // so an active session does not look like a hung log reader.
      else if (event.type === "session.reasoning.started") process.stdout.write("[thinking]\n");
      else if (["session.text.delta", "session.reasoning.delta"].includes(event.type))
        process.stdout.write(event.data.delta);
      else if (["session.text.ended", "session.reasoning.ended"].includes(event.type))
        process.stdout.write("\n");
      else if (
        [
          "session.tool.called",
          "session.tool.input.started",
          "session.tool.progress",
          "session.tool.success",
          "session.tool.failed",
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
        ].includes(event.type)
      )
        console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
    }
    await proc.wait();
    const err = await stderr;
    if (!stopped) throw new Error(`Event stream ended. Rerun logs to reconnect. ${err}`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await proc.cancel({ force: true }).catch(() => {});
    proc.close();
  }
}
