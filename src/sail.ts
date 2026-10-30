// Sail operations and the remote filesystem layout. Keep provider details here;
// run.ts decides when to provision, persist, and clean up each resource.
import {
  App,
  Client,
  EgressPolicy,
  Image,
  NotFoundError,
  Sailbox,
  Secret,
  type EgressPolicyDocument,
  type ExecOptions,
} from "@sailresearch/sdk";
import { once } from "node:events";
import exportScript from "./guest-export.py" with { type: "text" };
import type { Run } from "./state.ts";

export const home = "/home/longshot";
export const project = `${home}/project`;
export const session = `${home}/session`;
export const user = "longshot";
export function client(): Client {
  const apiKey = process.env.SAIL_API_KEY;
  if (!apiKey) throw new Error("Set SAIL_API_KEY in your environment.");
  return Client.fromConfig({ apiKey });
}
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function inferencePolicy(
  secretName: string,
  extra: EgressPolicyDocument = {},
): EgressPolicyDocument {
  if (extra.no_network) throw new Error("An inference run requires network access.");
  // Do not let a custom rule redirect an authenticated Sail request elsewhere.
  if (
    Object.keys(extra.rules ?? {}).some(
      (host) => host === "api.sailresearch.com" || host.includes("*"),
    )
  ) {
    throw new Error(
      "Additional policy rules must use exact hosts other than api.sailresearch.com.",
    );
  }
  return {
    ...extra,
    rules: {
      ...extra.rules,
      "api.sailresearch.com": [
        {
          match: { method: "POST", path: "/v1/chat/completions" },
          request: { set: { headers: { authorization: `Bearer \${secrets.${secretName}}` } } },
        },
      ],
    },
  };
}
export async function provisionBox(run: Run, api: Client) {
  const app = await App.find("longshot", { mintIfMissing: true, client: api });
  return Sailbox.create({
    client: api,
    app,
    name: run.name,
    size: run.config.size,
    image: Image.debian("amd64"),
    visibility: run.config.visibility,
    egressPolicy: run.policyId,
    autoSleep: { automatic: false },
  });
}
export async function getBox(run: Run, api = client()) {
  if (!run.boxId)
    throw new Error(
      "Sailbox creation was not confirmed. Use destroy to reconcile resources by the recorded run name.",
    );
  const box = await Sailbox.get(run.boxId, { client: api });
  if (box.status !== "running")
    throw new Error(`Sailbox is ${box.status}. Resume it in Sail before using this command.`);
  return box;
}
export async function command(box: Sailbox, args: string[], asUser = user, timeoutSeconds = 60) {
  const result = await box.run(args, {
    user: asUser,
    cwd: asUser === user ? project : "/",
    timeoutSeconds,
    outputBufferBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error(`Guest command failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  if (result.stdoutTruncated) throw new Error("Guest response exceeded the output limit.");
  return result.stdout;
}

// Download a portable copy without changing links in the running Sailbox.
export async function downloadDirectory(box: Sailbox, guestDir: string, localDir: string) {
  const staging = (
    await command(box, ["python3", "-c", exportScript, guestDir], user, 1200)
  ).trim();
  try {
    await box.fs.downloadDir({ guestDir: `${staging}/tree`, localDir });
  } finally {
    await box.fs.remove(staging, { user });
  }
}

// Setup output is progress, so both remote streams go to local stderr. Consume
// them together while waiting: an unread pipe can otherwise block the command.
export async function streamCommand(
  box: Sailbox,
  args: string[],
  options: ExecOptions,
  output?: (chunk: string, source: "stdout" | "stderr") => void | Promise<void>,
) {
  const proc = await box.exec(args, { ...options, outputMode: "pipe" });
  const forward = async (stream: AsyncIterable<string>, source: "stdout" | "stderr") => {
    for await (const chunk of stream) {
      if (output) await output(chunk, source);
      else if (!process.stderr.write(chunk)) await once(process.stderr, "drain");
    }
  };
  try {
    const [result] = await Promise.all([
      proc.wait(),
      forward(proc.stdout, "stdout"),
      forward(proc.stderr, "stderr"),
    ]);
    if (result.exitCode !== 0)
      throw new Error(`Setup command failed (${result.exitCode}). See the output above.`);
  } finally {
    proc.close();
  }
}

async function ignoreMissing(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
}

// Creation can succeed even if its HTTP response is lost. Reconcile exact unique
// names before cleanup; never retry create, or guess from a partial name match.
export async function cleanup(run: Run, api: Client, saved: () => Promise<void>) {
  const boxes = run.boxId
    ? [
        await Sailbox.get(run.boxId, { client: api }).catch((error) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        }),
      ]
    : (await Sailbox.list({ client: api })).filter((box) => box.name === run.name);
  for (const box of boxes) {
    if (!box) continue;
    run.boxId = box.sailboxId;
    await saved();
    if (box.status !== "terminated") await box.terminate();
  }
  // Stop on failure: a still-attached policy must retain its injection secret.
  const policies = run.policyId
    ? [run.policyId]
    : (await EgressPolicy.list({ client: api, search: run.name }))
        .filter((policy) => policy.name === run.name)
        .map((policy) => policy.id);
  for (const id of policies) {
    run.policyId = id;
    await saved();
    await ignoreMissing(async () => (await EgressPolicy.get(id, { client: api })).delete());
  }
  await ignoreMissing(() => Secret.deleteByName(run.secretName, { client: api }));
}
