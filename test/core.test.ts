import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  includeUpload,
  newRun,
  readConfig,
  readRun,
  saveRun,
  stageUpload,
} from "../src/state.ts";
import { estimateBudget } from "../src/pricing.ts";
import { configuration, events } from "../src/opencode.ts";
import { inferencePolicy } from "../src/sail.ts";

const directories: string[] = [];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "longshot-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("run state", () => {
  test("concurrent starts reserve exactly one run; partial IDs survive reload", async () => {
    const dir = await fixture();
    const config = await readConfig(dir);
    const first = newRun(config);
    const second = newRun(config);
    const results = await Promise.allSettled([createRun(dir, first), createRun(dir, second)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const run = await readRun(dir);
    run.policyId = "policy-test";
    await saveRun(dir, run, "creating-box");
    expect((await readRun(dir)).policyId).toBe("policy-test");
    expect((await readRun(dir)).stage).toBe("creating-box");
  });
  test("does not search parent directories; validates config before provisioning", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "longshot.json"), '{"model":"parent"}');
    await mkdir(join(dir, "child"));
    expect((await readConfig(join(dir, "child"))).model).not.toBe("parent");
    await writeFile(join(dir, "longshot.json"), '{"env":{"SAIL_API_KEY":"secret"}}');
    await expect(readConfig(dir)).rejects.toThrow("Reserved");
    await writeFile(join(dir, "longshot.json"), '{"budegt":50}');
    await expect(readConfig(dir)).rejects.toThrow("Unknown configuration");
    await writeFile(join(dir, "longshot.json"), '{"pricing":null}');
    await expect(readConfig(dir)).rejects.toThrow("pricing requires positive");
  });
});

test("upload stages uncommitted files and templates without recursing into state; links stay within the snapshot", async () => {
  const dir = await fixture();
  await mkdir(join(dir, ".longshot"));
  await mkdir(join(dir, "nested"));
  await mkdir(join(dir, "node_modules"));
  for (const name of [
    "source.ts",
    ".env",
    ".env.example",
    "nested/.env.local",
    "nested/new.txt",
    ".longshot/run.json",
    "node_modules/large",
    "ignored.log",
  ])
    await writeFile(join(dir, name), name);
  await symlink("source.ts", join(dir, "internal-link"));
  await symlink("generated-later.ts", join(dir, "dangling-link"));
  const snapshot = await stageUpload(dir, ["*.log"]);
  expect(await readFile(join(snapshot, "nested/new.txt"), "utf8")).toBe("nested/new.txt");
  expect(await readFile(join(snapshot, ".env.example"), "utf8")).toBe(".env.example");
  expect(await readlink(join(snapshot, "internal-link"))).toBe("source.ts");
  expect(await readlink(join(snapshot, "dangling-link"))).toBe("generated-later.ts");
  for (const name of [
    ".env",
    "nested/.env.local",
    ".longshot/run.json",
    "node_modules/large",
    "ignored.log",
  ])
    expect(await Bun.file(join(snapshot, name)).exists()).toBe(false);
  expect(includeUpload("packages/a/node_modules/x")).toBe(false);
});

test("budget is opt-in, bounded, and independent of cache discounts", () => {
  expect(estimateBudget(undefined, "unknown", "balanced")).toBeUndefined();
  expect(estimateBudget(50, "zai-org/GLM-5.3", "balanced")!.tokens).toBe(71_428_571);
  for (const dollars of [0, -1, NaN, Infinity, 1e30])
    expect(() => estimateBudget(dollars, "zai-org/GLM-5.3", "balanced")).toThrow();
  expect(() => estimateBudget(5, "unknown", "balanced")).toThrow("No bundled price");
  expect(estimateBudget(5, "unknown", "balanced", { input: 1, output: 1 })!.tokens).toBe(5_000_000);
});

test("generated config leaves budgets opt-in and restricts budgeted sessions", async () => {
  const run = newRun(await readConfig(await fixture()));
  const config = configuration(run);
  expect(config.plugins[0].options).not.toHaveProperty("default_token_budget");
  expect(config.providers.sail.body.metadata.completion_window).toBe("balanced");
  run.budget = estimateBudget(2, run.config.model, run.config.window);
  const bounded = configuration(run);
  expect(bounded.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  expect(bounded.plugins[0].options.default_token_budget).toBe(run.budget!.tokens);
});

test("injection matches only the intended Sail method and path", () => {
  const policy = inferencePolicy("run123", {
    rules: {
      "api.example.org": [
        { request: { set: { headers: { authorization: "Bearer ${secrets.OTHER}" } } } },
      ],
    },
  });
  expect(policy.rules!["api.sailresearch.com"][0].match).toEqual({
    method: "POST",
    path: "/v1/chat/completions",
  });
  expect(JSON.stringify(policy)).toContain("${secrets.run123}");
  expect(() => inferencePolicy("run", { rules: { "*": [] } })).toThrow();
  expect(() => inferencePolicy("run", { no_network: true })).toThrow();
});

test("SSE parser survives every chunk boundary and comments", async () => {
  const source =
    ': heartbeat\r\n\r\ndata: {"type":"one",\r\ndata: "data":{"delta":"héllo"}}\r\n\r\ndata: {"type":"two"}\n\n';
  for (let split = 0; split <= source.length; split++) {
    async function* chunks() {
      yield source.slice(0, split);
      yield source.slice(split);
    }
    const output = [];
    for await (const event of events(chunks())) output.push(event);
    expect(output).toEqual([{ type: "one", data: { delta: "héllo" } }, { type: "two" }]);
  }
});

test("upload rejects links into host files or excluded credentials before provisioning", async () => {
  for (const target of ["/outside/host", "../outside", ".env", "."]) {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), "fixture");
    await symlink(target, join(dir, "link"));
    await expect(stageUpload(dir, [])).rejects.toThrow("Upload symlink");
  }
});
