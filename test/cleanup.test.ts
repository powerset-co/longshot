import { afterEach, expect, spyOn, test } from "bun:test";
import { Client, EgressPolicy, Sailbox, Secret } from "@sailresearch/sdk";
import { cleanup } from "../src/sail.ts";
import { newRun, type Config } from "../src/state.ts";

const config: Config = {
  model: "zai-org/GLM-5.3",
  window: "balanced",
  size: "m",
  visibility: "org",
  env: {},
  exclude: [],
};
const api = Client.fromConfig({ apiKey: "fixture-not-a-real-key" });
const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

test("lost creation responses reconcile exact run names; cleanup keeps unrelated resources", async () => {
  const run = newRun(config);
  const order: string[] = [];
  const owned = {
    name: run.name,
    sailboxId: "owned-box",
    status: "running",
    terminate: async () => {
      order.push("box");
    },
  };
  const other = {
    name: run.name + "-other",
    sailboxId: "other-box",
    terminate: async () => {
      throw new Error("Unrelated box touched");
    },
  };
  mocks.push(spyOn(Sailbox, "list").mockResolvedValue([other, owned] as any));
  mocks.push(
    spyOn(EgressPolicy, "list").mockResolvedValue([
      { name: run.name, id: "owned-policy" },
      { name: run.name + "-other", id: "other-policy" },
    ] as any),
  );
  mocks.push(
    spyOn(EgressPolicy, "get").mockImplementation(async (id) => {
      expect(id).toBe("owned-policy");
      return {
        delete: async () => {
          order.push("policy");
        },
      } as any;
    }),
  );
  mocks.push(
    spyOn(Secret, "deleteByName").mockImplementation(async (name) => {
      expect(name).toBe(run.secretName);
      order.push("secret");
    }),
  );
  const persisted: unknown[] = [];
  await cleanup(run, api, async () => {
    persisted.push({ boxId: run.boxId, policyId: run.policyId });
  });
  expect(order).toEqual(["box", "policy", "secret"]);
  expect(persisted).toEqual([
    { boxId: "owned-box", policyId: undefined },
    { boxId: "owned-box", policyId: "owned-policy" },
  ]);
});

test("policy deletion failure preserves the secret and supports retry", async () => {
  const run = { ...newRun(config), boxId: "owned-box", policyId: "owned-policy" };
  mocks.push(
    spyOn(Sailbox, "get").mockResolvedValue({ status: "terminated", sailboxId: run.boxId } as any),
  );
  mocks.push(
    spyOn(EgressPolicy, "get").mockResolvedValue({
      delete: async () => {
        throw new Error("still attached");
      },
    } as any),
  );
  const secret = spyOn(Secret, "deleteByName").mockResolvedValue(undefined);
  mocks.push(secret);
  await expect(cleanup(run, api, async () => {})).rejects.toThrow("still attached");
  expect(secret).not.toHaveBeenCalled();
  expect(run.policyId).toBe("owned-policy");
});
