// Fork: native Jev (Vercel) answering 429 falls back to a LOCAL model, not to OpenRouter, and
// never holds when the local model answers.
import { describe, expect, it } from "vitest";
import { Jev, type SystemOne } from "../src/jev.js";

const menu = { HOLD: { desc: "stay flat", intent: { kind: "hold" as const } }, LONG_BTC: { desc: "buy BTC", intent: { kind: "hold" as const } } };
const ask = { strategy: "test", state: { px: 1 }, menu, convictionLabels: ["none", "weak", "medium", "strong"] };
const busy: SystemOne = { systemOne: () => Promise.reject(Object.assign(new Error("429 high demand"), { status: 429 })) };

function localFetch(calls: string[], content = '{"action":{"choice":"LONG_BTC","probabilities":{"HOLD":0.2,"LONG_BTC":0.8}},"conviction":2}') {
  return (async (url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    calls.push(`${url}|${b.model}|think=${b.think}`);
    return new Response(JSON.stringify({ model: b.model, prompt_eval_count: 120, message: { content } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const base = { apiKey: "vercel", model: "typesafe-ai/jev", timeoutMs: 1000, dailyUsdCap: 5, usdPerMTok: 0.042 };

describe("native Jev busy -> local model fallback", () => {
  it("answers through the local model for $0, then skips native while backed off", async () => {
    const calls: string[] = [];
    let native = 0;
    const client: SystemOne = { systemOne: (...a) => (native++, busy.systemOne(...a)) };
    const jev = new Jev({ ...base, client, localUrl: "http://localhost:11434/", localModel: "qwen3.6:35b-a3b", fetchImpl: localFetch(calls) });
    const r1 = await jev.decide(ask);
    expect(r1.ok && r1.choice).toBe("LONG_BTC");
    expect(r1.ok && r1.costUsd).toBe(0);
    expect(calls).toEqual(["http://localhost:11434/api/chat|qwen3.6:35b-a3b|think=false"]);
    const r2 = await jev.decide(ask);
    expect(r2.ok).toBe(true);
    expect(native).toBe(1); // second call went straight to the local model
    expect(jev.spentTodayUsd).toBe(0);
  });
  it("an off-menu local answer holds", async () => {
    const jev = new Jev({ ...base, client: busy, localUrl: "http://x", fetchImpl: localFetch([], '{"action":{"choice":"SHORT_ALL"},"conviction":3}') });
    const r = await jev.decide(ask);
    expect(r.ok).toBe(false);
  });
  it("without a local model configured, a busy native Jev still holds (fail closed)", async () => {
    const jev = new Jev({ ...base, client: busy });
    const r = await jev.decide(ask);
    expect(r.ok).toBe(false);
  });
});
