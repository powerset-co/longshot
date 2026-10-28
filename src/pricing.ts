// Sail publishes prices on its website, not in the documented /v1/models API.
// USD per million tokens; checked 2026-10-28: https://docs.sailresearch.com/pricing
const rates: Record<string, Record<string, [number, number]>> = {
  "zai-org/GLM-5.3": { asap: [0.98, 3.08], balanced: [0.5, 2.5], flex: [0.4, 1.8] },
  "zai-org/GLM-5.3-Flash": { asap: [0.11, 0.35], balanced: [0.08, 0.28], flex: [0.05, 0.18] },
  "moonshotai/Kimi-K3": { asap: [1.5, 10], balanced: [1.2, 8], flex: [0.7, 6] },
};
export interface Budget {
  dollars: number;
  tokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  inputFraction: number;
  ratesDate: string;
}
export function estimateBudget(
  dollars: number | undefined,
  model: string,
  window: string,
  override?: { input: number; output: number },
): Budget | undefined {
  if (dollars === undefined) return;
  if (!Number.isFinite(dollars) || dollars <= 0)
    throw new Error("Budget must be a positive dollar amount.");
  const pair = override ? [override.input, override.output] : rates[model]?.[window];
  if (!pair)
    throw new Error(
      "No bundled price for this model/window. Set pricing.input and pricing.output in longshot.json (USD per million tokens).",
    );
  const [input, output] = pair;
  if (![input, output].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Prices must be positive numbers.");
  // A deliberately simple estimate: 90% input, 10% output, no cache discount.
  const tokens = Math.floor((dollars * 1_000_000) / (0.9 * input + 0.1 * output));
  if (!Number.isSafeInteger(tokens) || tokens < 1)
    throw new Error("Budget produces an invalid token limit.");
  return {
    dollars,
    tokens,
    inputPerMillion: input,
    outputPerMillion: output,
    inputFraction: 0.9,
    ratesDate: override ? "user-supplied" : "2026-10-28",
  };
}
