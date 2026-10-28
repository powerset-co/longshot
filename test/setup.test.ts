// Run the actual setup shell against a temporary filesystem. Package downloads
// and account creation are stubbed; executable selection/version checks are real.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup from "../src/guest-setup.sh" with { type: "text" };

async function install(version: string) {
  const root = await mkdtemp(join(tmpdir(), "longshot-setup-"));
  try {
    for (const path of ["tmp", "usr/local/bin", "opt/longshot/opencode/package/bin"]) {
      await mkdir(join(root, path), { recursive: true });
    }
    const binary = join(root, "opt/longshot/opencode/package/bin/opencode");
    await writeFile(
      binary,
      '#!/bin/bash\ntest "$TEST_RUN_AS" = longshot || exit 1\nprintf "%s\\n" "$TEST_OPENCODE_VERSION"\n',
    );
    await chmod(binary, 0o755);
    await writeFile(join(root, "usr/local/bin/opencode"), "old executable");
    const script = [
      "apt-get() { :; }",
      "id() { return 0; }",
      "install() { :; }",
      'curl() { touch "$TEST_ROOT/tmp/opencode.tgz"; }',
      "tar() { :; }",
      'runuser() { test "$1:$2:$3" = "-u:longshot:--" || return 1; shift 3; TEST_RUN_AS=longshot "$@"; }',
      setup
        .replaceAll("/usr/local/bin", `${root}/usr/local/bin`)
        .replaceAll("/opt/longshot", `${root}/opt/longshot`)
        .replaceAll("/tmp/opencode.tgz", `${root}/tmp/opencode.tgz`),
    ].join("\n");
    const child = Bun.spawn(["bash", "-c", script], {
      env: {
        ...process.env,
        PATH: `${root}/usr/local/bin:${process.env.PATH}`,
        TEST_ROOT: root,
        TEST_OPENCODE_VERSION: version,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("setup replaces preinstalled OpenCode and accepts both version formats", async () => {
  for (const version of ["opencode v2.2.0", "2.2.0"]) {
    const result = await install(version);
    expect(result).toEqual({ code: 0, stderr: "" });
  }
});

test("setup reports the actual version when the pin does not match", async () => {
  const result = await install("opencode v1.0.0");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Expected OpenCode 2.2.0, got: opencode v1.0.0");
});
