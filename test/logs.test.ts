import { expect, spyOn, test } from "bun:test";
import type { Sailbox } from "@sailresearch/sdk";
import { logs } from "../src/opencode.ts";

// Use the real SSE reader and log function. A reasoning/tool-only turn must
// produce human output, while JSON mode must retain the original events.
test("logs show reasoning and tool activity, filter sessions, and preserve JSON", async () => {
  const events = [
    { type: "session.reasoning.delta", data: { sessionID: "other", delta: "unrelated" } },
    { type: "session.reasoning.started", data: { sessionID: "ours" } },
    { type: "session.reasoning.delta", data: { sessionID: "ours", delta: "Checking the files." } },
    { type: "session.reasoning.ended", data: { sessionID: "ours" } },
    { type: "session.tool.input.started", data: { sessionID: "ours", name: "write" } },
    { type: "session.tool.success", data: { sessionID: "ours", name: "write" } },
    {
      type: "rpc.opencode.goal.changed",
      data: { sessionID: "ours", goal: { status: "complete", reason: "All tests pass." } },
    },
    { type: "session.execution.succeeded", data: { sessionID: "ours" } },
  ];
  for (const json of [false, true]) {
    const output: string[] = [];
    const notices: string[] = [];
    let closed = false;
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const log = spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value) + "\n");
    });
    const error = spyOn(console, "error").mockImplementation((value) => {
      notices.push(String(value));
    });
    const box = {
      exec: async () => ({
        stdout: (async function* () {
          for (const event of events) yield `data: ${JSON.stringify(event)}\n\n`;
        })(),
        stderr: { text: async () => "" },
        wait: async () => ({ exitCode: 0 }),
        cancel: async () => {},
        close: () => {
          closed = true;
        },
      }),
    } as unknown as Sailbox;
    try {
      await expect(logs(box, "ours", json)).rejects.toThrow("Event stream ended");
      const text = output.join("");
      expect(text).not.toContain("unrelated");
      expect(closed).toBe(true);
      expect(notices.join(" ")).toContain("no history replay");
      if (json) {
        expect(
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(events.slice(1));
      } else {
        expect(text).toContain("[thinking]\nChecking the files.\n");
        expect(text).toContain("session.tool.input.started");
        expect(text).toContain("session.tool.success");
        expect(text).toContain("session.execution.succeeded");
        expect(text).toContain("[goal.complete] All tests pass.");
      }
    } finally {
      stdout.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  }
});
