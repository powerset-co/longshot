import { expect, spyOn, test } from "bun:test";
import { startupProgress } from "../src/progress.ts";

// Exercise the real renderer against a captured terminal, without cloud calls.
async function terminal(
  tty: boolean,
  json: boolean,
  check: (progress: ReturnType<typeof startupProgress>, output: string[]) => Promise<void>,
) {
  const descriptors = Object.getOwnPropertyDescriptors(process.stderr);
  const term = process.env.TERM;
  process.env.TERM = "xterm-256color";
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stderr, "columns", { configurable: true, value: 48 });
  const output: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => {
    throw new Error("Progress must never write to stdout");
  });
  const progress = startupProgress(json);
  try {
    await check(progress, output);
  } finally {
    progress.finish();
    stderr.mockRestore();
    stdout.mockRestore();
    for (const key of ["isTTY", "columns"] as const) {
      if (descriptors[key]) Object.defineProperty(process.stderr, key, descriptors[key]);
      else Reflect.deleteProperty(process.stderr, key);
    }
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
}

test("startup redraws only three recent lines, collapses success, and stops its timer", async () => {
  await terminal(true, false, async (progress, output) => {
    progress.stage("Installing OpenCode");
    await progress.write("old\none\ntwo\nthree\n", "stdout");
    await Bun.sleep(130);
    const frame = output.at(-1)!;
    expect(frame).toMatch(/Installing OpenCode \(\d+s\)/);
    expect(frame).toContain("  one\n  two\n  three\n");
    expect(frame).not.toContain("old");
    expect(frame).toContain("\x1b[1A");
    progress.stage("Starting goal");
    expect(output.at(-2)).toContain("✓ Installing OpenCode");
    expect(output.at(-2)).not.toContain("three");
    expect(output.at(-1)).not.toContain("three");
    progress.finish();
    expect(output.at(-1)).toContain("✓ Starting goal");
    const count = output.length;
    await Bun.sleep(130);
    expect(output).toHaveLength(count);
  });
});

test("failure keeps fragmented output from both pipes and stops redrawing", async () => {
  await terminal(true, false, async (progress, output) => {
    progress.stage("Installing");
    await progress.write("Down", "stdout");
    await progress.write("Warning\n", "stderr");
    await progress.write("load failed", "stdout");
    progress.finish(false);
    expect(output.at(-1)).toContain("✗ Installing");
    expect(output.at(-1)).toContain("Warning");
    expect(output.at(-1)).toContain("Download failed");
    const count = output.length;
    await Bun.sleep(130);
    expect(output).toHaveLength(count);
  });
});

test("remote control sequences and long Unicode lines cannot corrupt the display", async () => {
  await terminal(true, false, async (progress, output) => {
    progress.stage("Installing");
    await progress.write("\x1b[", "stdout");
    await progress.write("2J\x1b[31m" + "界".repeat(100) + "\x1b[0m\n", "stdout");
    progress.finish(false);
    const frame = output.at(-1)!;
    expect(frame).not.toContain("\x1b[2J");
    expect(frame).not.toContain("\x1b[31m");
    expect(frame).toContain("界");
    for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThan(48);
  });
});

for (const [tty, json] of [
  [false, false],
  [true, true],
]) {
  test(`plain startup preserves all output without animation (tty=${tty}, json=${json})`, async () => {
    await terminal(tty!, json!, async (progress, output) => {
      progress.stage("Installing");
      await progress.write("one\ntwo\nthree\nfour\n", "stdout");
      await progress.write("warning", "stderr");
      progress.finish();
      expect(output.join("")).toBe("Installing...\none\ntwo\nthree\nfour\nwarning");
    });
  });
}
