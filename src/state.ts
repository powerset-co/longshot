// All durable Longshot state belongs to the selected directory. The config is
// user input; run.json records the resolved settings and cloud resource IDs.
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const versions = { opencode: "2.2.1" };
export interface Config {
  model: string;
  window: "asap" | "balanced" | "flex";
  size: "s" | "m" | "l";
  visibility: "org" | "private";
  setup?: string;
  env: Record<string, string>;
  exclude: string[];
  egressPolicyFile?: string;
}
export interface Run {
  version: 1;
  name: string;
  createdAt: string;
  stage: string;
  config: Config;
  versions: typeof versions;
  secretName: string;
  policyId?: string;
  boxId?: string;
  sessionId?: string;
  destroyedAt?: string;
}
const stateDir = (directory: string) => join(directory, ".longshot");
const statePath = (directory: string) => join(stateDir(directory), "run.json");

export async function readConfig(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<Config> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(join(directory, "longshot.json"), "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("longshot.json must contain an object.");
  const allowed = [
    "model",
    "window",
    "size",
    "visibility",
    "setup",
    "env",
    "exclude",
    "egressPolicyFile",
  ];
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new Error(`Unknown configuration key: ${key}`);
  const config = {
    model: "zai-org/GLM-5.3",
    window: "balanced",
    size: "m",
    visibility: "org",
    env: {},
    exclude: [],
    ...raw,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  } as Config;
  for (const key of ["model", "setup", "egressPolicyFile"] as const) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]!.trim()))
      throw new Error(`Invalid ${key}.`);
  }
  if (!["asap", "balanced", "flex"].includes(config.window))
    throw new Error("window must be asap, balanced, or flex.");
  if (!["s", "m", "l"].includes(config.size)) throw new Error("size must be s, m, or l.");
  if (!["org", "private"].includes(config.visibility))
    throw new Error("visibility must be org or private.");
  if (!Array.isArray(config.exclude) || !config.exclude.every((x) => typeof x === "string"))
    throw new Error("exclude must be an array of glob strings.");
  if (!config.env || typeof config.env !== "object" || Array.isArray(config.env))
    throw new Error("env must be an object of non-secret strings.");
  for (const [key, value] of Object.entries(config.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
      throw new Error(`Invalid env entry: ${key}`);
    if (
      /^(SAIL|OPENCODE|XDG|BUN|LD_|DYLD_)/.test(key) ||
      ["HOME", "PATH", "NODE_OPTIONS"].includes(key)
    )
      throw new Error(`Reserved environment variable: ${key}`);
  }
  return config;
}

export function newRun(config: Config): Run {
  const name = `longshot-${crypto.randomUUID()}`;
  return {
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    stage: "prepared",
    config,
    versions,
    secretName: name,
  };
}
export async function readRun(directory: string): Promise<Run> {
  let run: Run;
  try {
    run = JSON.parse(await readFile(statePath(directory), "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error("No run in this directory. Use longshot start.");
    throw new Error(`Cannot read .longshot/run.json: ${error.message}`);
  }
  if (run.version !== 1 || !run.name || !run.config || !run.secretName)
    throw new Error("Unsupported or incomplete run.json. Preserve it for recovery.");
  return run;
}
export async function createRun(directory: string, run: Run) {
  await mkdir(stateDir(directory), { recursive: true, mode: 0o700 });
  // The record itself is the launch lock. A failed launch cannot silently launch again.
  try {
    await writeFile(statePath(directory), JSON.stringify(run, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: any) {
    if (error.code === "EEXIST")
      throw new Error(
        "This directory already has a run. Use status or destroy; start another run in a new directory.",
      );
    throw error;
  }
}
export async function saveRun(directory: string, run: Run, stage = run.stage) {
  // Rename replaces the record atomically, so an interrupted write leaves the
  // previous complete record available for status and cleanup.
  run.stage = stage;
  const temporary = `${statePath(directory)}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(run, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, statePath(directory));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function includeUpload(path: string, extra: string[] = []): boolean {
  const parts = path.split("/");
  if (parts.some((p) => [".longshot", ".git", "node_modules", ".DS_Store"].includes(p)))
    return false;
  const name = basename(path);
  if (
    (name === ".env" || name.startsWith(".env.")) &&
    ![".env.example", ".env.sample", ".env.template"].includes(name)
  )
    return false;
  return !extra.some((pattern) => new Bun.Glob(pattern).match(path));
}
export async function stageUpload(directory: string, exclude: string[]): Promise<string> {
  directory = await realpath(directory);
  const destination = join(stateDir(directory), "upload");
  // Keep relative links within the upload. Reject links that an archive tool
  // could follow back into excluded files or another host directory.
  await mkdir(destination, { recursive: true });
  // Copy children individually: cp refuses to copy a directory into itself.
  for (const entry of await readdir(directory)) {
    if (!includeUpload(entry, exclude)) continue;
    await cp(join(directory, entry), join(destination, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: async (source) => {
        if (!includeUpload(relative(directory, source), exclude)) return false;
        if ((await lstat(source)).isSymbolicLink()) {
          const link = await readlink(source);
          const target = resolve(dirname(source), link);
          const resolved = await realpath(target).catch((error: any) => {
            if (error.code === "ENOENT") return target;
            throw error;
          });
          const targetPath = relative(directory, resolved);
          const parentPath = relative(directory, dirname(source));
          const recursive =
            !targetPath || parentPath === targetPath || parentPath.startsWith(targetPath + "/");
          const outside = targetPath === ".." || targetPath.startsWith("../");
          if (isAbsolute(link) || recursive || outside || !includeUpload(targetPath, exclude)) {
            throw new Error(
              `Upload symlink is recursive, leaves the project, or targets an excluded file: ${relative(directory, source)}. Copy its contents into the project or exclude the link.`,
            );
          }
        }
        return true;
      },
    });
  }
  return destination;
}
export async function readInput(directory: string, text?: string, file?: string): Promise<string> {
  if (!!text === !!file) throw new Error("Supply text or --file, but not both.");
  const content = file ? await readFile(resolve(directory, file), "utf8") : text!;
  if (!content.trim()) throw new Error("Input cannot be empty.");
  return content;
}
