#!/usr/bin/env bun
// Command definitions are the single source for parsing, dispatch, and help.
import {
  defineCommand,
  runCommand,
  showUsage,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
} from "citty";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { resolve } from "node:path";
import { version } from "../package.json";
import { control, destroy, exportRun, start, status, type Options } from "./run.ts";
import { readInput } from "./state.ts";

const common = {
  directory: {
    type: "string",
    alias: "C",
    description: "Run directory (default: current directory)",
  },
  json: { type: "boolean", description: "Print machine-readable results" },
  help: { type: "boolean", alias: "h", description: "Show help" },
  version: { type: "boolean", description: "Show version" },
} satisfies ArgsDef;
const input = {
  text: { type: "positional", required: false, description: "Quoted goal or guidance" },
  file: { type: "string", alias: "f", description: "Read text from a file instead" },
} satisfies ArgsDef;

// Resolve the run directory at the CLI boundary. Configuration validation lives
// with the code that also reads longshot.json.
function options(args: { directory?: string; json?: boolean }): Options {
  return { ...args, directory: resolve(args.directory ?? process.cwd()), json: args.json ?? false };
}

const commands = {
  start: defineCommand({
    meta: { description: "Upload this directory and start a coding goal" },
    args: {
      ...common,
      ...input,
      model: { type: "string", description: "Sail model ID" },
      window: {
        type: "enum",
        options: ["asap", "balanced", "flex"],
        description: "Inference completion window",
      },
      size: { type: "enum", options: ["s", "m", "l"], description: "Sailbox size" },
      setup: { type: "string", description: "Project setup script" },
    },
    async run({ args }) {
      const opts = options(args);
      await start(opts, await readInput(opts.directory, args.text, args.file));
    },
  }),
  status: defineCommand({
    meta: { description: "Read sandbox health and goal progress" },
    args: common,
    run: ({ args }) => status(options(args)),
  }),
  logs: defineCommand({
    meta: { description: "Stream new session events; Ctrl+C disconnects" },
    args: common,
    run: ({ args }) => control("logs", options(args)),
  }),
  message: defineCommand({
    meta: { description: "Queue guidance in the existing session" },
    args: { ...common, ...input },
    async run({ args }) {
      const opts = options(args);
      await control("message", opts, await readInput(opts.directory, args.text, args.file));
    },
  }),
  attach: defineCommand({
    meta: { description: "Open the remote OpenCode TUI in this terminal" },
    args: common,
    run: ({ args }) => control("attach", options(args)),
  }),
  pause: defineCommand({
    meta: { description: "Pause goal continuation; the Sailbox stays running" },
    args: common,
    run: ({ args }) => control("pause", options(args)),
  }),
  resume: defineCommand({
    meta: { description: "Resume goal continuation" },
    args: common,
    run: ({ args }) => control("resume", options(args)),
  }),
  export: defineCommand({
    meta: { description: "Download workspace and session files into a fresh directory" },
    args: { ...common, output: { type: "string", alias: "o", description: "Export destination" } },
    run: ({ args }) => exportRun(options(args)),
  }),
  destroy: defineCommand({
    meta: { description: "Permanently remove this run's remote resources" },
    args: {
      ...common,
      yes: { type: "boolean", alias: "y", description: "Confirm permanent deletion" },
    },
    run: ({ args }) => destroy(options(args)),
  }),
};
const root = defineCommand({
  meta: {
    name: "longshot",
    version,
    description: "Long-running coding goals on Sailboxes. Set SAIL_API_KEY to start.",
  },
  args: common,
  subCommands: commands,
});

// Citty accepts unknown flags and extra positionals. Derive a strict Bun/Node
// parser from the same definitions so misspelled options fail before dispatch.
function flags(definitions: ArgsDef): ParseArgsOptionsConfig {
  const result: ParseArgsOptionsConfig = {};
  for (const [name, arg] of Object.entries(definitions)) {
    if (arg.type === "positional") continue;
    const option: ParseArgsOptionsConfig[string] = {
      type: arg.type === "boolean" ? "boolean" : "string",
    };
    if ("alias" in arg && typeof arg.alias === "string") option.short = arg.alias;
    result[name] = option;
  }
  return result;
}

export async function main(rawArgs = Bun.argv.slice(2)) {
  // Token offsets let global flags appear before or after the command, even
  // when a flag's value happens to be the name of a command (e.g. -C status).
  const allArgs = Object.assign({}, ...Object.values(commands).map((cmd) => cmd.args));
  const parsed = parseArgs({
    args: rawArgs,
    options: flags(allArgs),
    allowPositionals: true,
    tokens: true,
  });
  const token = parsed.tokens.find((token) => token.kind === "positional");
  if (!token) {
    if (parsed.values.version) console.log(version);
    else await showUsage(root);
    return;
  }
  const name = token.value;
  if (!Object.hasOwn(commands, name)) throw new Error(`Unknown command: ${name}. Use --help.`);
  const cmd: CommandDef<any> = commands[name as keyof typeof commands];
  const definitions = cmd.args as ArgsDef; // All definitions above are plain objects.
  const args = rawArgs.filter((_, index) => index !== token.index);
  const allowedFlags = flags(definitions);
  for (const token of parsed.tokens) {
    if (token.kind === "option" && !Object.hasOwn(allowedFlags, token.name)) {
      throw new Error(`--${token.name} is not valid for ${name}.`);
    }
  }
  const positionalCount = Object.values(definitions).filter(
    (arg) => arg.type === "positional",
  ).length;
  if (parsed.positionals.length - 1 > positionalCount) {
    throw new Error("Unexpected positional arguments. Quote the goal/message as one argument.");
  }
  if (parsed.values.help)
    return showUsage({ ...cmd, meta: { ...(cmd.meta as CommandMeta), name } }, root);
  if (parsed.values.version) {
    console.log(version);
    return;
  }
  await runCommand(cmd, { rawArgs: args });
}

if (import.meta.main) {
  await main().catch((error) => {
    let message = error instanceof Error ? error.message : String(error);
    if (process.env.SAIL_API_KEY)
      message = message.replaceAll(process.env.SAIL_API_KEY, "[redacted]");
    console.error(
      Bun.argv.includes("--json") ? JSON.stringify({ error: message }) : `Error: ${message}`,
    );
    process.exitCode = 1;
  });
}
