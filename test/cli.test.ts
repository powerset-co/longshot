// Exercise the public process boundary: generated help, argv parsing, output,
// exit codes, and filesystem effects. No Sail connection is needed.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRun, newRun, readConfig } from "../src/state.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "longshot cli "));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function invoke(directory: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: directory,
    env: { ...process.env, SAIL_API_KEY: "", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("generated root and command help never start a run", async () => {
  const directory = await fixture();
  const root = await invoke(directory, []);
  expect(root.code).toBe(0);
  expect(root.stdout).toContain("start");
  expect(root.stdout).toContain("destroy");
  const start = await invoke(directory, ["start", "--help"]);
  expect(start.code).toBe(0);
  expect(start.stdout).toContain("--budget");
  expect(start.stdout).toContain("default: none");
  expect(start.stdout).not.toContain("undefined");
  const status = await invoke(directory, ["status", "-h"]);
  expect(status.stdout).not.toContain("--budget");
  expect(await Bun.file(join(directory, ".longshot/run.json")).exists()).toBe(false);
});

test("invalid input fails before provisioning with one JSON error on stderr", async () => {
  const directory = await fixture();
  for (const args of [
    ["start", "goal", "--budegt", "10"],
    ["status", "--budget", "10"],
    ["start", "unquoted", "goal"],
    ["status", "extra"],
    ["start", "--budget"],
    ["start", "--window", "tomorrow", "goal"],
    ["start", "goal", "--file", "GOAL.md"],
    ["start"],
    ["destroy"],
    ["unknown"],
  ]) {
    const result = await invoke(directory, ["--json", ...args]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toBeString();
    expect(result.stderr).not.toContain("Set SAIL_API_KEY");
  }
  expect(await Bun.file(join(directory, ".longshot/run.json")).exists()).toBe(false);
});

test("global flags work on either side of the command, including a directory named status", async () => {
  const directory = await fixture();
  const child = join(directory, "status");
  await mkdir(child);
  const run = newRun(await readConfig(child));
  run.destroyedAt = new Date().toISOString();
  await createRun(child, run);
  for (const args of [
    ["-C", "status", "--json", "status"],
    ["status", "--directory", "status", "--json"],
  ]) {
    const result = await invoke(directory, args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).name).toBe(run.name);
  }
});

test("start forwards model and budget options to validation", async () => {
  const directory = await fixture();
  const result = await invoke(directory, [
    "start",
    "goal",
    "--model",
    "unknown-model",
    "--budget",
    "5",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toContain("No bundled price");
});
