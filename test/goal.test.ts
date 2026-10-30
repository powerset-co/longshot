// Exercise Longshot's HTTP boundary and lifecycle guards without cloud resources.
// The fake Sail exec forwards curl's URL and stdin to a small API fixture.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Client, Sailbox } from "@sailresearch/sdk";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goal, latestActivity, type Goal } from "../src/opencode.ts";
import { control, exportRun, status } from "../src/run.ts";
import { createRun, newRun, readConfig, saveRun } from "../src/state.ts";

const directories: string[] = [];
const mocks: { mockRestore(): void }[] = [];
const originalKey = process.env.SAIL_API_KEY;
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode ?? 0;
  for (const mock of mocks.splice(0)) mock.mockRestore();
  if (originalKey === undefined) delete process.env.SAIL_API_KEY;
  else process.env.SAIL_API_KEY = originalKey;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function boxFor(handle: (url: URL, body: any) => unknown) {
  return {
    status: "running",
    exec: async (args: string[]) => {
      const url = new URL(args.find((arg) => arg.startsWith("http://"))!);
      let stdin = "";
      let sent!: () => void;
      const ready = args.includes("--data-binary")
        ? new Promise<void>((resolve) => {
            sent = resolve;
          })
        : Promise.resolve();
      return {
        writeStdin: async (data: string) => {
          stdin += data;
        },
        closeStdin: async () => {
          sent();
        },
        stdout: {
          text: async () => {
            await ready;
            const result = handle(url, stdin ? JSON.parse(stdin) : undefined);
            return result === undefined ? "" : JSON.stringify(result);
          },
        },
        stderr: { text: async () => "" },
        wait: async () => ({ exitCode: 0 }),
        close: () => {},
      };
    },
  } as unknown as Sailbox;
}

const progress: Goal = {
  id: "goal-1",
  objective: "Verify the project",
  status: "paused",
  reason: "Paused by the user",
  rounds: 2,
  maxRounds: 50,
  boot: "server-1",
  updatedAt: 123,
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "longshot-goal-"));
  directories.push(directory);
  const run = { ...newRun(await readConfig(directory)), boxId: "box-1", sessionId: "session-1" };
  await createRun(directory, run);
  process.env.SAIL_API_KEY = "fixture-not-a-real-key";
  // Sailbox.get is mocked below, so no native SDK client is needed. Repeated
  // client initialization can otherwise exhaust the test timeout on macOS CI.
  mocks.push(spyOn(Client, "fromConfig").mockReturnValue({} as Client));
  return { run, options: { directory, json: true } };
}

test("goal status uses the native RPC envelope and project location", async () => {
  const { run } = await fixture();
  let output: Goal | null = progress;
  const box = boxFor((url, body) => {
    expect(url.pathname).toBe("/api/rpc/opencode.goal/get");
    expect(url.searchParams.get("location[directory]")).toBe("/home/longshot/project");
    expect(body).toEqual({ input: { sessionID: run.sessionId } });
    return { output };
  });
  expect(await goal(box, run)).toEqual(progress);
  output = null;
  expect(await goal(box, run)).toBeNull();
});

test("status exposes the review reason and rounds without a model request", async () => {
  const { options } = await fixture();
  const box = boxFor((url) => {
    if (url.pathname === "/api/rpc/opencode.goal/get") return { output: progress };
    if (url.pathname === "/api/session/active") return { data: {} };
    if (url.pathname === "/api/session/session-1") return { data: { time: { created: 1000 } } };
    if (url.pathname === "/api/session/session-1/message")
      return {
        data: [
          {
            time: { created: 1000, streamed: 2000 },
            content: [{ type: "text", text: "Tests are passing." }],
          },
        ],
      };
    if (/\/(permission|form)$/.test(url.pathname)) return { data: [] };
    throw new Error(`Unexpected request: ${url}`);
  });
  mocks.push(spyOn(Sailbox, "get").mockResolvedValue(box));
  const output = spyOn(console, "log").mockImplementation(() => {});
  mocks.push(output);
  await status(options);
  const result = JSON.parse(output.mock.calls[0]![0]);
  expect(result.goal).toEqual(progress);
  expect(result.execution).toBe("idle");
  expect(result.activity).toEqual({
    type: "text",
    summary: "Tests are passing.",
    recordedAt: 2000,
  });
  expect(result).not.toHaveProperty("estimatedInferenceDollars");
  await status({ ...options, json: false });
  const human = output.mock.calls.at(-1)![0];
  expect(human).toContain("Goal update: Paused by the user");
  expect(human).toContain("Activity: Tests are passing.");
  expect(human).toContain("Recorded: 1970-01-01T00:00:02.000Z");
});

test("status does not report running when the execution query fails", async () => {
  const { options } = await fixture();
  const box = boxFor((url) => {
    if (url.pathname === "/api/rpc/opencode.goal/get") return { output: progress };
    throw new Error("Execution query failed");
  });
  mocks.push(spyOn(Sailbox, "get").mockResolvedValue(box));
  const output = spyOn(console, "log").mockImplementation(() => {});
  mocks.push(output);
  await status({ ...options, json: false });
  expect(process.exitCode).toBe(1);
  expect(output.mock.calls[0]![0]).toContain("Execution: unavailable");
  expect(output.mock.calls[0]![0]).toContain("Error: Execution query failed");
});

test("status measures session wall time, including pauses, and freezes it at completion", async () => {
  const { options } = await fixture();
  const created = 1_700_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(created + 272_999);
  mocks.push(clock);
  let current: Goal = { ...progress, status: "active", updatedAt: created + 60_000 };
  const box = boxFor((url) => {
    if (url.pathname === "/api/rpc/opencode.goal/get") return { output: current };
    if (url.pathname === "/api/session/active") return { data: {} };
    if (url.pathname === "/api/session/session-1") return { data: { time: { created } } };
    if (/\/(permission|form|message)$/.test(url.pathname)) return { data: [] };
    throw new Error(`Unexpected request: ${url}`);
  });
  mocks.push(spyOn(Sailbox, "get").mockResolvedValue(box));
  const output = spyOn(console, "log").mockImplementation(() => {});
  mocks.push(output);
  for (const state of ["active", "paused"] as const) {
    current.status = state;
    await status(options);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).elapsedMs).toBe(272_999);
    await status({ ...options, json: false });
    expect(output.mock.calls.at(-1)![0]).toContain("Elapsed: 4m 32s");
  }
  clock.mockReturnValue(created + 90_061_000);
  await status({ ...options, json: false });
  expect(output.mock.calls.at(-1)![0]).toContain("Elapsed: 1d 1h 1m 1s");
  current = { ...current, status: "complete", updatedAt: created + 272_999 };
  for (const later of [created + 300_000, created + 86_400_000]) {
    clock.mockReturnValue(later);
    await status(options);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).elapsedMs).toBe(272_999);
  }
  // A resumed goal counts the full wall time again. Small host/guest clock
  // differences must never produce a negative duration.
  current.status = "active";
  await status(options);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).elapsedMs).toBe(86_400_000);
  clock.mockReturnValue(created - 1000);
  await status({ ...options, json: false });
  expect(output.mock.calls.at(-1)![0]).toContain("Elapsed: 0s");
});

test("status leaves elapsed time unavailable before session creation", async () => {
  const { run, options } = await fixture();
  await saveRun(options.directory, { ...run, sessionId: undefined });
  mocks.push(
    spyOn(Sailbox, "get").mockResolvedValue(
      boxFor(() => {
        throw new Error("No session API should be called before session creation");
      }),
    ),
  );
  const output = spyOn(console, "log").mockImplementation(() => {});
  mocks.push(output);
  await status(options);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).elapsedMs).toBeNull();
  await status({ ...options, json: false });
  expect(output.mock.calls.at(-1)![0]).not.toContain("Elapsed:");
});

test("activity reads a bounded page and prefers a running parallel tool", async () => {
  const box = boxFor((url, body) => {
    expect(url.pathname).toBe("/api/session/session-1/message");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "assistant",
      order: "desc",
      limit: "3",
    });
    expect(body).toBeUndefined();
    return {
      data: [
        { time: { created: 4000 }, content: [] },
        {
          time: { created: 1000 },
          content: [
            {
              type: "tool",
              name: "shell",
              state: { status: "running", input: { command: "python3\n -m unittest" } },
              time: { created: 1100, ran: 1200 },
            },
            {
              type: "tool",
              name: "read",
              state: { status: "completed", input: { path: "README.md" } },
              time: { created: 1300, completed: 1400 },
            },
          ],
        },
      ],
    };
  });
  expect(await latestActivity(box, "session-1")).toEqual({
    type: "tool",
    summary: "shell (running): python3 -m unittest",
    recordedAt: 1200,
  });
});

test("activity handles partial reasoning, streamed tool input, and empty history", async () => {
  const cases = [
    {
      content: [{ type: "reasoning", text: "\u001b[32mChecking\u001b[0m\n the parser." }],
      expected: { type: "reasoning", summary: "Checking the parser.", recordedAt: 1000 },
    },
    {
      content: [
        {
          type: "tool",
          name: "write",
          state: { status: "streaming", input: '{"path":' },
          time: { created: 1100 },
        },
      ],
      expected: { type: "tool", summary: "write (streaming)", recordedAt: 1100 },
    },
    { content: [{ type: "text", text: " \n " }], expected: null },
    { content: [], expected: null },
  ] as const;
  for (const item of cases) {
    const box = boxFor(() => ({ data: [{ time: { created: 1000 }, content: item.content }] }));
    expect(await latestActivity(box, "session-1")).toEqual(item.expected);
  }
  expect(
    await latestActivity(
      boxFor(() => ({ data: [] })),
      "session-1",
    ),
  ).toBeNull();
});

test("activity bounds long text and uses completion timestamps for settled tools", async () => {
  const text = await latestActivity(
    boxFor(() => ({
      data: [
        {
          time: { created: 1000, streamed: 2000 },
          content: [{ type: "text", text: "x".repeat(1000) }],
        },
      ],
    })),
    "session-1",
  );
  expect(text!.summary.length).toBe(240);
  expect(text!.summary.endsWith("...")).toBe(true);
  const tool = await latestActivity(
    boxFor(() => ({
      data: [
        {
          time: { created: 1000, streamed: 2000 },
          content: [
            {
              type: "tool",
              name: "write",
              state: {
                status: "completed",
                input: { path: "logstats.py", content: "do not display the file contents" },
              },
              time: { created: 1500, ran: 1800, completed: 2500 },
            },
          ],
        },
      ],
    })),
    "session-1",
  );
  expect(tool).toEqual({
    type: "tool",
    summary: "write (completed): logstats.py",
    recordedAt: 2500,
  });
});

test("pause and resume use native commands and report an immediate re-pause", async () => {
  const { options } = await fixture();
  let current: Goal = { ...progress, status: "active" };
  const commands: unknown[] = [];
  const box = boxFor((url, body) => {
    if (url.pathname === "/api/rpc/opencode.goal/get") return { output: current };
    expect(url.pathname).toBe("/api/session/session-1/command");
    commands.push(body);
    current = {
      ...progress,
      reason: body.text === "resume" ? "The session failed: fixture" : progress.reason,
    };
  });
  mocks.push(spyOn(Sailbox, "get").mockResolvedValue(box));
  const output = spyOn(console, "log").mockImplementation(() => {});
  mocks.push(output);
  await control("pause", options);
  await control("resume", options);
  expect(commands).toEqual([
    { name: "goal", text: "pause" },
    { name: "goal", text: "resume" },
  ]);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).goal.reason).toBe("The session failed: fixture");
});

test("export refuses active goals and paused goals with work still running", async () => {
  const { options } = await fixture();
  let running = true;
  const box = boxFor((url) => {
    if (url.pathname === "/api/rpc/opencode.goal/get")
      return { output: { ...progress, status: running ? "paused" : "active" } };
    if (url.pathname === "/api/session/active") return { data: running ? { "session-1": {} } : {} };
    throw new Error(`Unexpected request: ${url}`);
  });
  mocks.push(spyOn(Sailbox, "get").mockResolvedValue(box));
  await expect(exportRun(options)).rejects.toThrow("wait for execution to become idle");
  running = false;
  await expect(exportRun(options)).rejects.toThrow("wait for execution to become idle");
  expect(await readdir(join(options.directory, ".longshot"))).toEqual(["run.json"]);
});

test("legacy runs cannot be mistaken for native runs with no goal", async () => {
  const { run } = await fixture();
  const legacy = { ...run, versions: { opencode: "2.2.0", goal: "0.1.84" } };
  await expect(
    goal(
      boxFor(() => {
        throw new Error("Should not call the native API");
      }),
      legacy,
    ),
  ).rejects.toThrow("original Longshot binary");
});
