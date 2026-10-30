import { expect, spyOn, test } from "bun:test";
import type { Sailbox } from "@sailresearch/sdk";
import { streamCommand } from "../src/sail.ts";

test("setup can forward both labeled pipes to the compact display", async () => {
  const output: string[] = [];
  const box = {
    exec: async () => ({
      stdout: (async function* () {
        yield "Installing\n";
      })(),
      stderr: (async function* () {
        yield "Warning\n";
      })(),
      wait: async () => ({ exitCode: 0 }),
      close() {},
    }),
  } as unknown as Sailbox;
  await streamCommand(box, ["bash", "setup.sh"], {}, async (chunk, source) => {
    output.push(`${source}: ${chunk}`);
  });
  expect(output).toContain("stdout: Installing\n");
  expect(output).toContain("stderr: Warning\n");
});

test("setup output reaches stderr before exit, with both streams consumed concurrently", async () => {
  const output: string[] = [];
  let finish!: (result: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>((resolve) => {
    finish = resolve;
  });
  let streamed!: () => void;
  const progress = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    if (output.length === 2) streamed();
    return true;
  });
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => {
    throw new Error("Setup must not write to stdout (including --json mode)");
  });
  let closed = false;
  async function* stream(text: string) {
    yield text;
    await exit;
  }
  const options = { user: "longshot", cwd: "/project", env: { CI: "true" }, timeoutSeconds: 1200 };
  const box = {
    exec: async (args: string[], received: unknown) => {
      expect(args).toEqual(["bash", "setup.sh"]);
      expect(received).toEqual({ ...options, outputMode: "pipe" });
      return {
        stdout: stream("Installing packages...\n"),
        stderr: stream("Package warning\n"),
        wait: () => exit,
        close: () => {
          closed = true;
        },
      };
    },
  } as unknown as Sailbox;
  const pending = streamCommand(box, ["bash", "setup.sh"], options);
  try {
    // Neither stream ends until finish() is called. A buffered or sequential
    // implementation would never deliver both messages at this point.
    await progress;
    expect(output).toContain("Installing packages...\n");
    expect(output).toContain("Package warning\n");
    expect(closed).toBe(false);
    finish({ exitCode: 0 });
    await pending;
    expect(closed).toBe(true);
  } finally {
    finish({ exitCode: 0 });
    await pending.catch(() => {});
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

for (const failure of ["exit", "stream", "wait"] as const) {
  test(`setup propagates ${failure} failures and releases the exec handle`, async () => {
    let closed = false;
    const output: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const box = {
      exec: async () => ({
        stdout: (async function* () {
          if (failure === "stream") throw new Error("Stream disconnected");
          yield "Installer output\n";
        })(),
        stderr: (async function* () {
          yield "Diagnostic\n";
        })(),
        wait: async () => {
          if (failure === "wait") throw new Error("Command timed out");
          return { exitCode: 7 };
        },
        close: () => {
          closed = true;
        },
      }),
    } as unknown as Sailbox;
    try {
      const message = {
        exit: "Setup command failed (7)",
        stream: "Stream disconnected",
        wait: "Command timed out",
      }[failure];
      await expect(streamCommand(box, ["bash", "setup.sh"], {})).rejects.toThrow(message);
      expect(closed).toBe(true);
      if (failure === "exit") expect(output.join("")).toContain("Diagnostic");
    } finally {
      stderr.mockRestore();
    }
  });
}
