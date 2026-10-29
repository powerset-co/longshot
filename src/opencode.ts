// OpenCode listens only inside the Sailbox. HTTP requests travel through Sail
// exec + guest curl; there is no public server, local proxy, or background daemon.
import type { Sailbox } from "@sailresearch/sdk";
import { stripVTControlCharacters } from "node:util";
import type { Run } from "./state.ts";
import { home, project, quote, session, user } from "./sail.ts";

export interface Goal {
  id: string;
  status: "active" | "paused" | "complete";
  objective: string;
  reason?: string;
  rounds: number;
  maxRounds: number;
  stalls?: number;
  boot: string;
  updatedAt: number;
}
const location = `?location%5Bdirectory%5D=${encodeURIComponent(project)}`;

// Native objectives are limited to 4,000 characters. Keep the complete user
// specification in a file, and give both the agent and reviewer a stable reference.
export const goalObjective = `Complete the task described in ${session}/goal.md. Read that file before working, satisfy all of its requirements, and verify the result with appropriate tests before declaring completion.`;

export function configuration(run: Run) {
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
        models: { coder: { modelID: run.config.model, name: run.config.model } },
      },
    },
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      // A headless question otherwise waits indefinitely. The goal can report a blocker.
      { action: "question", resource: "*", effect: "deny" },
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
    OPENCODE_PASSWORD: password,
    SAIL_INFERENCE_PLACEHOLDER: "injected-by-sail",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  await box.fs.write(`${session}/config/opencode/opencode.json`, JSON.stringify(config), {
    user,
    mode: 0o600,
  });
  // A remote wrapper gives the server and attached TUI identical paths.
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
  // Built-in plugins activate asynchronously, so a listening server alone is
  // not sufficient: wait until the native goal command has registered.
  await until(
    async () => {
      try {
        await api(box, "/api/info");
        const commands = await api<{ data: { name: string }[] }>(box, "/api/command" + location);
        return commands.data.some((x) => x.name === "goal");
      } catch {
        return false;
      }
    },
    "OpenCode goal mode did not become ready. Inspect the exported session/server.log.",
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
// OpenCode owns persistence. This RPC reads its goal state without inference.
export async function goal(box: Sailbox, run: Run): Promise<Goal | null> {
  // Old runs remain on their original server/plugin. Do not silently migrate
  // them or mistake a missing native goal for permission to export active work.
  if ("goal" in run.versions)
    throw new Error(
      "This run uses the legacy goal plugin. Use its original Longshot binary for status, pause/resume, and export. Attach, logs, message, and destroy still work.",
    );
  const result = await api<{ output: Goal | null }>(box, "/api/rpc/opencode.goal/get" + location, {
    input: { sessionID: run.sessionId },
  });
  return result.output;
}

export interface Activity {
  type: "text" | "reasoning" | "tool";
  summary: string;
  recordedAt: number;
}

// Only the fields needed for a short status line, from OpenCode's message API.
interface AssistantMessage {
  time: { created: number; streamed?: number; completed?: number };
  content: (
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
    | {
        type: "tool";
        name: string;
        state: { status: string; input: string | Record<string, unknown> };
        time: { created: number; ran?: number; completed?: number };
      }
  )[];
}

export async function latestActivity(box: Sailbox, id: string): Promise<Activity | null> {
  const result = await api<{ data: AssistantMessage[] }>(
    box,
    `/api/session/${id}/message?type=assistant&order=desc&limit=3`,
  );
  // A newly started step may have no content yet. Look back a few messages,
  // without fetching the whole conversation or creating a local event cache.
  for (const message of result.data) {
    const parts = [...message.content].reverse();
    // Parallel tools can finish out of order; show any still-running tool first.
    const running = parts.find(
      (part) => part.type === "tool" && ["running", "streaming"].includes(part.state.status),
    );
    for (const part of running ? [running, ...parts] : parts) {
      let summary: string;
      let recordedAt = message.time.streamed ?? message.time.completed ?? message.time.created;
      if (part.type === "tool") {
        const input = typeof part.state.input === "object" ? part.state.input : {};
        const detail = [input.path, input.command, input.pattern, input.description].find(
          (value) => typeof value === "string" && value.trim(),
        );
        summary = `${part.name} (${part.state.status})${detail ? `: ${detail}` : ""}`;
        recordedAt = part.time.completed ?? part.time.ran ?? part.time.created;
      } else {
        summary = part.text;
        if (part.type === "reasoning" && part.time)
          recordedAt = part.time.completed ?? part.time.created;
      }
      summary = stripVTControlCharacters(summary).replace(/\s+/g, " ").trim();
      if (!summary) continue;
      return {
        type: part.type,
        summary: summary.length > 240 ? summary.slice(0, 237) + "..." : summary,
        recordedAt,
      };
    }
  }
  return null;
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
      else if (event.type === "rpc.opencode.goal.changed") {
        const current = event.data.goal as Goal | null;
        console.log(
          current
            ? `[goal.${current.status}] ${current.reason ?? current.objective}`
            : "[goal.cleared]",
        );
      }
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
