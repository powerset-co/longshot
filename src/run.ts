// Run lifecycle. Startup is deliberately linear: persist each resource ID before
// taking the next step, and leave failures inspectable rather than rolling back.
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EgressPolicy, Sailbox, Secret, type EgressPolicyDocument } from "@sailresearch/sdk";
import setupScript from "./guest-setup.sh" with { type: "text" };
import { createRun, newRun, readConfig, readRun, saveRun, stageUpload, versions } from "./state.ts";
import {
  cleanup,
  client,
  command,
  getBox,
  inferencePolicy,
  project,
  provisionBox,
  quote,
  session,
  user,
} from "./sail.ts";
import { api, goal, logs, prepare, until, type Goal } from "./opencode.ts";
import type { Budget } from "./pricing.ts";

export interface Options {
  directory: string;
  json: boolean;
  budget?: number;
  model?: string;
  window?: string;
  size?: string;
  setup?: string;
  output?: string;
  yes?: boolean;
}
function report(value: unknown, json: boolean, human: string) {
  const output = json ? JSON.stringify(value) : human;
  console.log(
    process.env.SAIL_API_KEY ? output.replaceAll(process.env.SAIL_API_KEY, "[redacted]") : output,
  );
}

export async function start(options: Options, objective: string) {
  const directory = options.directory;
  const config = await readConfig(directory, {
    model: options.model,
    window: options.window,
    size: options.size,
    setup: options.setup,
  });
  const run = newRun(config, options.budget);
  const apiClient = client();
  const customSetup = config.setup
    ? await readFile(resolve(directory, config.setup), "utf8")
    : null;
  const extraPolicy: EgressPolicyDocument = config.egressPolicyFile
    ? JSON.parse(await readFile(resolve(directory, config.egressPolicyFile), "utf8"))
    : {};
  const policy = inferencePolicy(run.secretName, extraPolicy);
  // Finish local validation before reserving this directory or creating cloud resources.
  await createRun(directory, run);
  try {
    console.error("Preparing project files...");
    const upload = await stageUpload(directory, config.exclude);
    // Unique names prevent accidental replacement of another run's secret.
    await saveRun(directory, run, "creating-secret");
    await Secret.set(run.secretName, process.env.SAIL_API_KEY!, { client: apiClient });
    await saveRun(directory, run, "creating-policy");
    run.policyId = (await EgressPolicy.create(run.name, policy, { client: apiClient })).id;
    await saveRun(directory, run, "creating-box");
    console.error("Creating Sailbox (compute charges start now)...");
    const box = await provisionBox(run, apiClient);
    run.boxId = box.sailboxId;
    await saveRun(directory, run, "setting-up");
    console.error(`Sailbox ${run.boxId}: installing OpenCode ${versions.opencode}...`);
    await box.fs.write("/tmp/longshot-setup.sh", setupScript, { mode: 0o700 });
    await command(box, ["bash", "/tmp/longshot-setup.sh"], "0:0", 1200);
    await box.fs.uploadDir({ localDir: upload, guestDir: project, user });
    await rm(upload, { recursive: true, force: true });
    await box.fs.write(`${session}/goal.md`, objective, { user });
    if (customSetup !== null) {
      await box.fs.write(`${session}/setup.sh`, customSetup, { user, mode: 0o700 });
      const result = await box.run(["bash", "-e", `${session}/setup.sh`], {
        cwd: project,
        user,
        env: config.env,
        timeoutSeconds: 1200,
      });
      console.error(result.stdout);
      console.error(result.stderr);
      if (result.exitCode !== 0)
        throw new Error(`Project setup failed (${result.exitCode}). Sailbox preserved.`);
    }
    await saveRun(directory, run, "starting-server");
    await prepare(box, run);
    const created = await api<{ data: { id: string } }>(box, "/api/session", {
      location: { directory: project },
      title: "Longshot",
      model: { providerID: "sail", id: "coder" },
      agent: "build",
    });
    run.sessionId = created.data.id;
    await saveRun(directory, run, "starting-goal");
    await api(box, `/api/session/${run.sessionId}/command`, { name: "goal", text: objective });
    await until(
      async () => !!(await goal(box, run.sessionId!)),
      "Goal submission was accepted but creation was not confirmed. Inspect status/logs before sending another message.",
    );
    const current = (await goal(box, run.sessionId))!;
    if (current.tokenBudget !== (run.budget?.tokens ?? null)) {
      await api(box, `/api/session/${run.sessionId}/command`, { name: "pause_goal", text: "" });
      throw new Error(
        "The model created a goal with an unexpected token budget. Paused continuation; inspect the session.",
      );
    }
    await saveRun(directory, run, "started");
    report(
      { boxId: run.boxId, sessionId: run.sessionId, goal: current, budget: run.budget ?? null },
      options.json,
      `Started ${run.boxId}\nSession: ${run.sessionId}\nBudget: ${run.budget ? `approximately $${run.budget.dollars} (${run.budget.tokens.toLocaleString()} tokens)` : "none"}\nUse longshot status, logs, or attach.`,
    );
  } catch (error) {
    console.error(
      `Startup stopped at ${run.stage}. Resources are preserved; use status or destroy in this directory.`,
    );
    throw error;
  }
}

// Only fields used by status are projected from the plugin's larger history.
interface RunStatus {
  name: string;
  stage: string;
  boxId: string | null;
  sessionId: string | null;
  budget: Budget | null;
  versions: typeof versions;
  sandbox: string;
  goal: Goal | null;
  execution: unknown;
  estimatedInferenceDollars?: number;
  permissions?: unknown[];
  forms?: unknown[];
  error?: string;
}

export async function status(options: Options) {
  const run = await readRun(options.directory);
  const result: RunStatus = {
    name: run.name,
    stage: run.stage,
    boxId: run.boxId ?? null,
    sessionId: run.sessionId ?? null,
    budget: run.budget ?? null,
    versions: run.versions,
    sandbox: run.destroyedAt ? "terminated" : "not-confirmed",
    goal: null,
    execution: null,
  };
  if (run.boxId && !run.destroyedAt) {
    try {
      const box = await Sailbox.get(run.boxId, { client: client() });
      result.sandbox = box.status;
      if (box.status === "running" && run.sessionId) {
        const current = await goal(box, run.sessionId);
        // Status is a compact observation, not a dump of the entire goal history.
        result.goal = current && {
          status: current.status,
          objective: current.objective,
          tokensUsed: current.tokensUsed,
          tokenBudget: current.tokenBudget,
          autoTurns: current.autoTurns,
          timeUsedSeconds: current.timeUsedSeconds,
          stopReason: current.stopReason,
          lastCheckpoint: current.lastCheckpoint,
          completionEvidence: current.completionEvidence,
          blocker: current.blocker,
          planRevision: current.planRevision,
        };
        if (current && run.budget)
          result.estimatedInferenceDollars =
            (current.tokensUsed * run.budget.dollars) / run.budget.tokens;
        const active = await api<{ data: Record<string, unknown> }>(box, "/api/session/active");
        result.execution = active.data[run.sessionId] ?? "idle";
        result.permissions = (
          await api<{ data: unknown[] }>(box, `/api/session/${run.sessionId}/permission`)
        ).data;
        result.forms = (
          await api<{ data: unknown[] }>(box, `/api/session/${run.sessionId}/form`)
        ).data;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  const lines = [
    `Sailbox: ${result.boxId ?? "not confirmed"} (${result.sandbox})`,
    `Setup: ${run.stage}`,
    `Session: ${run.sessionId ?? "not created"}`,
    `Goal: ${result.goal?.status ?? "unavailable"}`,
  ];
  if (result.goal) {
    const current = result.goal;
    const limit = current.tokenBudget === null ? " (no budget)" : ` / ${current.tokenBudget}`;
    lines.push(`Tokens: ${current.tokensUsed}${limit}`);
    lines.push(`Execution: ${result.execution === "idle" ? "idle" : "running"}`);
    if (current.stopReason) lines.push(`Stop reason: ${current.stopReason}`);
    if (current.lastCheckpoint?.summary) lines.push(current.lastCheckpoint.summary);
  }
  if (result.permissions?.length) lines.push(`Pending permissions: ${result.permissions.length}`);
  if (result.forms?.length) lines.push(`Pending questions: ${result.forms.length}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  report(result, options.json, lines.join("\n"));
}

export async function control(
  action: "logs" | "attach" | "message" | "pause" | "resume",
  options: Options,
  text?: string,
) {
  const run = await readRun(options.directory);
  if (run.destroyedAt) throw new Error("This run was destroyed.");
  if (!run.sessionId)
    throw new Error(
      "No OpenCode session was recorded. Inspect status or destroy the incomplete run.",
    );
  const box = await getBox(run);
  const id = run.sessionId;
  // These commands operate on the same remote session. No local process owns it.
  switch (action) {
    case "logs":
      return logs(box, id, options.json);
    case "attach": {
      if (options.json || !process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          "attach requires an interactive terminal. Use status --json or logs --json for automation.",
        );
      process.exitCode = await box.shell(
        `${quote(session + "/opencode")} ${quote(project)} --server http://127.0.0.1:4096 --session ${quote(id)}`,
        { user, cwd: project, term: "xterm-256color", noForward: true },
      );
      return;
    }
    case "message": {
      // Queue delivery lets guidance arrive while a model/tool call is in flight.
      await api(box, `/api/session/${id}/prompt`, { text, delivery: "queue" });
      return report(
        { sessionId: id, accepted: true },
        options.json,
        "Message queued. Use status or logs to follow its delivery.",
      );
    }
    case "pause":
    case "resume": {
      // Commands are asynchronous: distinguish acceptance from a confirmed state change.
      const current = await goal(box, id);
      if (!current) throw new Error("No goal has been created yet.");
      if (
        action === "resume" &&
        (current.status === "budgetLimited" ||
          (current.tokenBudget !== null && current.tokensUsed >= current.tokenBudget))
      ) {
        throw new Error(
          "The goal's token budget is exhausted. Longshot does not increase or reset budgets.",
        );
      }
      if (["complete", "unmet", "cancelled"].includes(current.status))
        throw new Error(`Goal is ${current.status}; it cannot be ${action}d by Longshot.`);
      if (
        action === "pause" &&
        ["paused", "budgetLimited", "usageLimited"].includes(current.status)
      ) {
        return report(
          { goal: current },
          options.json,
          `Goal is already ${current.status}. The Sailbox remains running.`,
        );
      }
      if (action === "resume" && current.status === "active")
        return report({ goal: current }, options.json, "Goal is already active.");
      if (action === "resume") {
        // The plugin needs a fresh execution to recognize an explicit resume.
        const active = await api<{ data: Record<string, unknown> }>(box, "/api/session/active");
        if (id in active.data)
          throw new Error("Wait for status to show execution is idle before resuming the goal.");
      }
      await api(box, `/api/session/${id}/command`, {
        name: action === "pause" ? "pause_goal" : "resume_goal",
        text: "",
      });
      await until(async () => {
        const next = await goal(box, id);
        if (!next) return false;
        if (action === "pause") {
          return ["paused", "budgetLimited", "usageLimited", "complete"].includes(next.status);
        }
        return next.status === "active" || next.status === "complete";
      }, `${action} was submitted but the expected goal state was not confirmed. Inspect status/logs.`);
      return report(
        { goal: await goal(box, id) },
        options.json,
        action === "pause"
          ? "Goal continuation paused. In-flight work may finish; the Sailbox remains running."
          : "Goal resumed.",
      );
    }
  }
}

export async function exportRun(options: Options) {
  const run = await readRun(options.directory);
  if (run.destroyedAt) throw new Error("Cannot export a destroyed Sailbox.");
  const box = await getBox(run);
  if (run.sessionId) {
    const current = await goal(box, run.sessionId);
    const active = await api<{ data: Record<string, unknown> }>(box, "/api/session/active");
    if (current?.status === "active" || run.sessionId in active.data)
      throw new Error("Pause the goal and wait for execution to become idle before exporting.");
  }
  const destination = resolve(
    options.directory,
    options.output ?? join(".longshot", "exports", new Date().toISOString().replaceAll(":", "-")),
  );
  // Reserve the destination; failed downloads remain visibly marked as partial.
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  const marker = join(destination, ".partial");
  await Bun.write(marker, "Export in progress or interrupted. Source Sailbox is unchanged.\n");
  console.error(`Downloading workspace and session to ${destination}...`);
  await box.fs.downloadDir({ guestDir: project, localDir: join(destination, "workspace") });
  // SQLite's backup API produces a consistent database even while the server is open.
  // Keep the copy separate from live WAL files rather than copying a changing database.
  const hasDatabase = await box.fs.exists(`${session}/opencode.db`);
  if (hasDatabase)
    await command(box, [
      "python3",
      "-c",
      `import sqlite3
source = sqlite3.connect("file:${session}/opencode.db?mode=ro", uri=True)
destination = sqlite3.connect("${session}/export.db")
source.backup(destination)
destination.execute("PRAGMA journal_mode=DELETE")
destination.close()
source.close()
`,
    ]);
  if (await box.fs.exists(session))
    await box.fs.downloadDir({ guestDir: session, localDir: join(destination, "session") });
  if (hasDatabase) {
    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(destination, "session", `opencode.db${suffix}`), { force: true });
    await rename(
      join(destination, "session", "export.db"),
      join(destination, "session", "opencode.db"),
    );
  }
  await Bun.write(join(destination, "run.json"), JSON.stringify(run, null, 2) + "\n");
  await rm(marker);
  report({ output: destination }, options.json, `Exported to ${destination}`);
}
export async function destroy(options: Options) {
  if (!options.yes)
    throw new Error(
      "destroy permanently removes the remote files. Export first, then use destroy --yes.",
    );
  const run = await readRun(options.directory);
  if (run.destroyedAt) return report({ destroyed: true }, options.json, "Run already destroyed.");
  console.error("Terminating Sailbox and removing this run's policy and inference secret...");
  await cleanup(run, client(), () => saveRun(options.directory, run, "destroying"));
  run.destroyedAt = new Date().toISOString();
  await saveRun(options.directory, run, "destroyed");
  report(
    { destroyed: true, boxId: run.boxId },
    options.json,
    "Destroyed remote resources. Local state and exports are preserved.",
  );
}
