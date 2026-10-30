import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sailbox } from "@sailresearch/sdk";
import exportScript from "../src/guest-export.py" with { type: "text" };
import { downloadDirectory } from "../src/sail.ts";

test("export rebases internal absolute links without following external links or editing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "longshot-export-test-"));
  const source = join(root, "session");
  let staging = "";
  try {
    const cache = join(source, "cache");
    await mkdir(join(cache, "bun-types"), { recursive: true });
    await mkdir(join(cache, "bun-types@1.4.4"));
    await writeFile(join(cache, "bun-types@1.4.4", "index.d.ts"), "contents");
    await writeFile(join(source, ".hidden"), "hidden contents");
    await symlink(join(cache, "bun-types@1.4.4"), join(cache, "bun-types", "1.4.4"));
    await symlink(join(cache, "bun-types@1.4.4", "index.d.ts"), join(source, "absolute-file"));
    await symlink("cache/bun-types@1.4.4/index.d.ts", join(source, "relative-file"));
    await symlink(join(source, "missing"), join(source, "dangling"));
    const outside = join(root, "session-other");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "outside contents");
    await symlink(outside, join(source, "external"));
    const proc = Bun.spawn(["python3", "-c", exportScript, source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    staging = stdout.trim();
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const tree = join(staging, "tree");
    expect(await readlink(join(tree, "cache/bun-types/1.4.4"))).toBe("../bun-types@1.4.4");
    expect(await readlink(join(tree, "absolute-file"))).toBe("cache/bun-types@1.4.4/index.d.ts");
    expect(await readlink(join(tree, "relative-file"))).toBe("cache/bun-types@1.4.4/index.d.ts");
    expect(await readlink(join(tree, "dangling"))).toBe("missing");
    expect(await readlink(join(tree, "external"))).toBe(outside);
    expect(await Bun.file(join(tree, "absolute-file")).text()).toBe("contents");
    expect(await Bun.file(join(tree, ".hidden")).text()).toBe("hidden contents");
    expect(await readlink(join(source, "cache/bun-types/1.4.4"))).toBe(
      join(cache, "bun-types@1.4.4"),
    );
    expect(await Bun.file(join(outside, "keep")).text()).toBe("outside contents");
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("export always removes its temporary guest copy, including rejected archives", async () => {
  for (const fails of [false, true]) {
    const removed: string[] = [];
    const box = {
      run: async () => ({ exitCode: 0, stdout: "/tmp/longshot-export-fixture\n" }),
      fs: {
        downloadDir: async (paths: unknown) => {
          expect(paths).toEqual({
            guestDir: "/tmp/longshot-export-fixture/tree",
            localDir: "/local/export",
          });
          if (fails) throw new Error("archive link points outside the destination");
        },
        remove: async (path: string) => {
          removed.push(path);
        },
      },
    } as unknown as Sailbox;
    const download = downloadDirectory(box, "/guest/session", "/local/export");
    if (fails) await expect(download).rejects.toThrow("outside the destination");
    else await download;
    expect(removed).toEqual(["/tmp/longshot-export-fixture"]);
  }
});
