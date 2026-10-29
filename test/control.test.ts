import { expect, spyOn, test } from "bun:test";
import { Sailbox } from "@sailresearch/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control } from "../src/run.ts";
import { createRun, newRun, readConfig } from "../src/state.ts";

// Pausing can leave an execution running. Submitting resume into that execution
// loses the plugin's explicit-resume marker and leaves the goal paused.
test("resume refuses a busy session, then succeeds once that session is idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longshot-control-"));
  const originalKey = process.env.SAIL_API_KEY;
  process.env.SAIL_API_KEY = "fixture-not-a-real-key";
  let busy = true;
  let status = "paused";
  const commands: string[] = [];
  const box = {
    status: "running",
    fs: {
      exists: async () => true,
      read: async () =>
        Buffer.from(JSON.stringify({ version: 3, goals: { ours: { status, tokenBudget: null } } })),
    },
    exec: async (args: string[]) => {
      const url = args.find((arg) => arg.startsWith("http://"))!;
      const isStatus = url.endsWith("/api/session/active");
      if (!isStatus) commands.push(url);
      return {
        stdout: { text: async () => JSON.stringify({ data: busy ? { ours: {} } : { other: {} } }) },
        stderr: { text: async () => "" },
        wait: async () => ({ exitCode: 0 }),
        writeStdin: async (body: string) => {
          expect(JSON.parse(body).name).toBe("resume_goal");
          status = "active";
        },
        closeStdin: async () => {},
        close: () => {},
      };
    },
  };
  const get = spyOn(Sailbox, "get").mockResolvedValue(box as any);
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const run = { ...newRun(await readConfig(directory)), boxId: "box", sessionId: "ours" };
    await createRun(directory, run);
    await expect(control("resume", { directory, json: true })).rejects.toThrow("execution is idle");
    expect(commands).toHaveLength(0);
    expect(status).toBe("paused");
    busy = false;
    await control("resume", { directory, json: true });
    expect(commands).toEqual(["http://127.0.0.1:4096/api/session/ours/command"]);
    expect(status).toBe("active");
  } finally {
    get.mockRestore();
    output.mockRestore();
    if (originalKey === undefined) delete process.env.SAIL_API_KEY;
    else process.env.SAIL_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});
