// Test the real installer with local release archives. Only curl/uname are
// substituted: checksum verification, extraction, execution, and replacement
// all use the host tools. No network or writes to the user's bin directory.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installer from "../scripts/install.sh" with { type: "text" };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(version = "0.1.0", payloadVersion = version) {
  const root = await mkdtemp(join(tmpdir(), "longshot install "));
  roots.push(root);
  const home = join(root, "home");
  const tools = join(root, "tools");
  const release = join(root, "release");
  const payload = join(root, "payload");
  for (const path of [home, tools, release, payload]) await mkdir(path);
  async function executable(path: string, text: string) {
    await writeFile(path, text);
    await chmod(path, 0o755);
  }
  await executable(join(payload, "longshot"), `#!/bin/sh\nprintf '%s\\n' '${payloadVersion}'\n`);
  await executable(
    join(tools, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo "$TEST_OS";; -m) echo "$TEST_ARCH";; esac\n',
  );
  await executable(
    join(tools, "curl"),
    `#!/bin/sh
set -eu
[ "$1" = -fsSL ] && [ "$3" = -o ]
printf '%s\\n' "$2" >> "$TEST_ROOT/requests"
case "$2" in
  "https://github.com/powerset-co/longshot/releases/download/v$TEST_VERSION/"*) ;;
  *) echo "Unexpected release URL" >&2; exit 22;;
esac
if [ "\${TEST_DOWNLOAD_FAIL:-}" = 1 ]; then exit 22; fi
cp "$TEST_ROOT/release/\${2##*/}" "$4"
`,
  );
  let checksums = "";
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    const name = `longshot-${platform}.tar.gz`;
    const archive = join(release, name);
    const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", payload, "longshot"]);
    expect(packed.exitCode).toBe(0);
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(archive).arrayBuffer())
      .digest("hex");
    checksums += `${hash}  ${name}\n`;
  }
  await writeFile(join(release, "SHA256SUMS"), checksums);
  const script = join(root, "install.sh");
  await writeFile(script, installer.replaceAll("@VERSION@", "0.1.0"));
  const bin = join(home, ".local/bin");
  async function run(args: string[] = [], env: Record<string, string> = {}) {
    const child = Bun.spawn(["sh", script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${tools}:${process.env.PATH}`,
        TEST_ROOT: root,
        TEST_VERSION: version,
        TEST_OS: "Darwin",
        TEST_ARCH: "arm64",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return { root, home, bin, release, run };
}

test("installer selects all release platforms and prints PATH instructions", async () => {
  const f = await fixture();
  for (const [os, arch, platform] of [
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Linux", "aarch64", "linux-arm64"],
    ["Linux", "x86_64", "linux-x64"],
  ]) {
    const result = await f.run([], { TEST_OS: os, TEST_ARCH: arch });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(await readFile(join(f.root, "requests"), "utf8")).toContain(
      `longshot-${platform}.tar.gz`,
    );
    expect(
      Bun.spawnSync([join(f.bin, "longshot"), "--version"])
        .stdout.toString()
        .trim(),
    ).toBe("0.1.0");
    expect(await readdir(f.bin)).toEqual(["longshot"]);
  }
});

test("installer supports pinned versions and destinations with spaces", async () => {
  const f = await fixture("0.2.0");
  const bin = join(f.root, "custom bin");
  const result = await f.run(["--version", "v0.2.0", "--bin-dir", bin]);
  expect(result.code).toBe(0);
  expect(
    Bun.spawnSync([join(bin, "longshot"), "--version"])
      .stdout.toString()
      .trim(),
  ).toBe("0.2.0");
});

test("failed downloads and bad checksums preserve the installed executable", async () => {
  const f = await fixture();
  await mkdir(f.bin, { recursive: true });
  const binary = join(f.bin, "longshot");
  await writeFile(binary, "previous installation");
  expect((await f.run([], { TEST_DOWNLOAD_FAIL: "1" })).code).not.toBe(0);
  expect(await readFile(binary, "utf8")).toBe("previous installation");
  await writeFile(join(f.release, "longshot-darwin-arm64.tar.gz"), "corrupt download");
  const corrupt = await f.run();
  expect(corrupt.code).not.toBe(0);
  expect(corrupt.stderr).toContain("Checksum mismatch");
  expect(await readFile(binary, "utf8")).toBe("previous installation");
  await writeFile(join(f.release, "SHA256SUMS"), "");
  expect((await f.run()).stderr).toContain("Missing or invalid checksum");
});

test("unsupported systems and invalid flags fail before downloading", async () => {
  const f = await fixture();
  expect((await f.run([], { TEST_OS: "Windows" })).code).not.toBe(0);
  expect((await f.run([], { TEST_ARCH: "riscv64" })).code).not.toBe(0);
  for (const args of [
    ["--unknown"],
    ["--version"],
    ["--bin-dir", ""],
    ["--version", "../../main"],
  ]) {
    expect((await f.run(args)).code).not.toBe(0);
  }
  expect((await f.run(["--help"])).code).toBe(0);
  expect(await Bun.file(join(f.root, "requests")).exists()).toBe(false);
});

test("a checksum-valid archive with the wrong version cannot replace the installed binary", async () => {
  const f = await fixture("0.1.0", "0.2.0");
  await mkdir(f.bin, { recursive: true });
  const binary = join(f.bin, "longshot");
  await writeFile(binary, "previous installation");
  const result = await f.run();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Expected version 0.1.0, got 0.2.0");
  expect(await readFile(binary, "utf8")).toBe("previous installation");
});
