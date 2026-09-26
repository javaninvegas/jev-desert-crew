// fork: Hawk (bee4), Jev with free rein. Parser, planner, exits, no-cap rule, and the engine end to end.
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { applyExitPlan, hawkExitHit, hawkMaxNotional, hawkReport, parseHawkReply, planHawk, type HawkAnswer } from "../src/hawk.js";
import { Jev } from "../src/jev.js";
import { freshBee } from "../src/ledger.js";
import type { MarketFeed } from "../src/market/data.js";
import type { MarketView } from "../src/market/types.js";
import { Alerts } from "../src/alerts.js";
import { bee, coin, NOW, position, testConfig, view } from "./fixtures.js";

const UNIVERSE = ["BTC", "ETH", "SOL"];
const FEE = 0.005;
const buy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "BUY", coin: "SOL", size_pct: 40, take_profit_pct: 4, stop_loss_pct: 2, invalidation: "SOL loses 140", reason: "strongest 7d mover", ...over });

describe("Hawk: parsing Jev's answer", () => {
  it("accepts a complete BUY", () => {
    const r = parseHawkReply(buy(), UNIVERSE);
    expect(r).toEqual({
      ok: true,
      clamped: null,
      answer: { action: "BUY", coin: "SOL", size_pct: 40, take_profit_pct: 4, stop_loss_pct: 2, invalidation: "SOL loses 140", reason: "strongest 7d mover" },
    });
  });

  it("reads JSON wrapped in prose or a code fence, and normalises the coin", () => {
    const r = parseHawkReply("Sure:\n```json\n" + buy({ action: "buy", coin: "sol_usd" }) + "\n```", UNIVERSE);
    expect(r.ok && r.answer).toMatchObject({ action: "BUY", coin: "SOL" });
  });

  it("HOLD and SELL need nothing else", () => {
    expect(parseHawkReply('{"action":"HOLD","coin":null,"reason":"chop"}', UNIVERSE)).toMatchObject({ ok: true, answer: { action: "HOLD", size_pct: null } });
    expect(parseHawkReply('{"action":"SELL","coin":"SOL","reason":"invalidated"}', UNIVERSE)).toMatchObject({ ok: true, answer: { action: "SELL", coin: "SOL" } });
  });

  it("fails closed on invalid replies", () => {
    expect(parseHawkReply("I think SOL looks good", UNIVERSE)).toMatchObject({ ok: false, code: "BAD_JSON" });
    expect(parseHawkReply("[1,2]", UNIVERSE)).toMatchObject({ ok: false, code: "BAD_JSON" });
    expect(parseHawkReply(buy({ action: "SHORT" }), UNIVERSE)).toMatchObject({ ok: false, code: "BAD_ACTION" });
    expect(parseHawkReply(buy({ size_pct: "lots" }), UNIVERSE)).toMatchObject({ ok: false, code: "BAD_SIZE" });
    expect(parseHawkReply(buy({ take_profit_pct: null }), UNIVERSE)).toMatchObject({ ok: false, code: "BAD_EXIT_PLAN" });
    expect(parseHawkReply(buy({ stop_loss_pct: 0 }), UNIVERSE)).toMatchObject({ ok: false, code: "BAD_EXIT_PLAN" });
    expect(parseHawkReply(buy({ stop_loss_pct: 100 }), UNIVERSE)).toMatchObject({ ok: false, code: "BAD_EXIT_PLAN" });
  });

  it("refuses a coin outside the gated universe", () => {
    expect(parseHawkReply(buy({ coin: "PEPE" }), UNIVERSE)).toMatchObject({ ok: false, code: "OFF_UNIVERSE" });
    expect(parseHawkReply(buy({ action: "SWITCH", coin: null }), UNIVERSE)).toMatchObject({ ok: false, code: "OFF_UNIVERSE" });
  });

  it("clamps size_pct into 5-100", () => {
    const hi = parseHawkReply(buy({ size_pct: 250 }), UNIVERSE);
    expect(hi.ok && hi.answer.size_pct).toBe(100);
    expect(hi.ok && hi.clamped).toMatch(/250 clamped to 100/);
    const lo = parseHawkReply(buy({ size_pct: 1 }), UNIVERSE);
    expect(lo.ok && lo.answer.size_pct).toBe(5);
  });
});

const sol = coin("SOL", {}, 100);
const btc = coin("BTC", {}, 50_000);
const v = () => view([btc, sol]);
const answer = (over: Partial<HawkAnswer> = {}): HawkAnswer => ({ action: "BUY", coin: "SOL", size_pct: 40, take_profit_pct: 4, stop_loss_pct: 2, invalidation: "", reason: "", ...over });
const plan = (a: HawkAnswer, b = bee("bee4"), mv: MarketView = v()) => planHawk({ answer: a, bee: b, view: mv, takerFeeRate: FEE, dataStale: false });

describe("Hawk: turning the answer into a trade", () => {
  it("BUY while flat opens that share of equity", () => {
    const r = plan(answer());
    expect(r.action).toMatchObject({ kind: "open", instId: sol.instId, side: "long" });
    expect(r.action.kind === "open" && r.action.notionalUsd).toBeCloseTo(0.4 * 333, 6);
    expect(r.countsAsTrade).toBe(true);
  });

  it("size is clamped so notional plus fee never exceeds equity (spot, no leverage)", () => {
    const r = plan(answer({ size_pct: 100 }));
    const n = r.action.kind === "open" ? r.action.notionalUsd : NaN;
    expect(n).toBeCloseTo(hawkMaxNotional(333, FEE), 6);
    expect(n * (1 + FEE)).toBeLessThanOrEqual(333 + 1e-9);
  });

  it("SWITCH sizes from equity after the exit fee", () => {
    const b = bee("bee4", { position: position(btc, { contracts: 300 }) });
    const r = plan(answer({ action: "SWITCH", size_pct: 100 }), b);
    expect(r.action.kind).toBe("switch");
    const n = r.action.kind === "switch" ? r.action.notionalUsd : NaN;
    expect(n).toBeLessThan(hawkMaxNotional(333, FEE));
  });

  it("buy-only: there is no short, SELL only ever closes, and SELL while flat does nothing", () => {
    expect(plan(answer({ action: "SELL", coin: null })).action.kind).toBe("none");
    const held = bee("bee4", { position: position(sol) });
    expect(plan(answer({ action: "SELL", coin: "SOL" }), held).action).toEqual({ kind: "close", reason: "jev_sell" });
    for (const a of ["BUY", "SWITCH"] as const) {
      const r = plan(answer({ action: a }));
      expect(r.action.kind === "open" || r.action.kind === "switch" ? r.action.side : "long").toBe("long");
    }
  });

  it("BUY of a different coin while holding is refused (that is a SWITCH); BUY of the held coin tops up", () => {
    const held = bee("bee4", { position: position(btc, { contracts: 50 }) });
    expect(plan(answer(), held)).toMatchObject({ action: { kind: "none" }, vetoedBy: "holding_other_coin" });
    const small = bee("bee4", { position: position(sol, { contracts: 50 }) }); // $50 of SOL
    const r = plan(answer({ size_pct: 40 }), small);
    expect(r.action.kind).toBe("add");
    expect(r.action.kind === "add" && r.action.notionalUsd).toBeCloseTo(0.4 * 333 - 50, 6);
  });

  it("no trade cap: a busy day still trades", () => {
    const busy = bee("bee4", { tradesToday: 500, feesTodayUsd: 80 });
    expect(plan(answer(), busy).action.kind).toBe("open");
  });

  it("HOLD holds, and stale data holds", () => {
    expect(plan(answer({ action: "HOLD", coin: null })).action.kind).toBe("none");
    expect(planHawk({ answer: answer(), bee: bee("bee4"), view: v(), takerFeeRate: FEE, dataStale: true }).vetoedBy).toBe("stale_market_data");
  });
});

describe("Hawk: Jev's own exit plan", () => {
  it("sets target and stop from the entry, and code fires them", () => {
    const p = position(sol, { entryPx: 100, contracts: 100 });
    applyExitPlan(p, answer({ take_profit_pct: 5, stop_loss_pct: 2, invalidation: "breaks 95" }), 1 / 100);
    expect(p.takeProfitPx).toBeCloseTo(105, 9);
    expect(p.stopPx).toBeCloseTo(98, 9);
    expect(p.invalidation).toBe("breaks 95");
    expect(hawkExitHit(p, 101)).toBeNull();
    expect(hawkExitHit(p, 105)).toBe("take_profit");
    expect(hawkExitHit(p, 97.9)).toBe("stop_loss");
  });

  it("the report carries every gated coin and Hawk's books", () => {
    const b = bee("bee4", { position: position(sol, { takeProfitPx: 104, stopPx: 98, invalidation: "x" }) });
    const r = hawkReport({ bee: b, view: v(), startEquityUsd: 333, takerFeeRate: FEE, now: NOW, last: null }) as { coins: { rows: Record<string, unknown> }; me: { position: { take_profit_px: number } } };
    expect(Object.keys(r.coins.rows)).toEqual(["BTC", "SOL"]);
    expect(r.me.position.take_profit_px).toBe(104);
  });
});

describe("Hawk: Jev call", () => {
  it("a timeout holds (fail closed)", async () => {
    const never: typeof fetch = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const j = new Jev({ provider: "openrouter", apiKey: "k", model: "m", timeoutMs: 1000, dailyUsdCap: 5, usdPerMTok: 0, fetchImpl: never });
    const r = await j.askRaw("sys", "{}", { timeoutMs: 20, maxOutputTokens: 256 });
    expect(r).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("counts toward the shared daily cap", async () => {
    const f: typeof fetch = async () => new Response(JSON.stringify({ model: "x", usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.002 }, choices: [{ message: { content: "{}" } }] }));
    const j = new Jev({ provider: "openrouter", apiKey: "k", model: "m", timeoutMs: 1000, dailyUsdCap: 0.003, usdPerMTok: 0, fetchImpl: f });
    expect(await j.askRaw("s", "u", { timeoutMs: 1000, maxOutputTokens: 256 })).toMatchObject({ ok: true, costUsd: 0.002, inputTokens: 900, outputTokens: 80 });
    await j.askRaw("s", "u", { timeoutMs: 1000, maxOutputTokens: 256 });
    expect(await j.askRaw("s", "u", { timeoutMs: 1000, maxOutputTokens: 256 })).toMatchObject({ ok: false, reason: "daily_cap" });
  });
});

describe("Hawk in the engine", () => {
  it("joins an existing three-bee run without touching it, trades on Jev's answer, and takes its own profit", async () => {
    const cfg = testConfig({ JEV_PROVIDER: "openrouter", TAKER_FEE_RATE: "0.005", MAX_LEVERAGE: "1" });
    expect(cfg.slots.bee4).toMatchObject({ style: "hawk", name: "Hawk" });
    const db = new Db(":memory:");
    // The run that was already going: three bees with history, no bee4 row.
    const existing = {
      bee1: { ...freshBee("bee1", 333, NOW - 3_600_000), flatSince: NOW },
      bee2: { ...freshBee("bee2", 333, NOW - 3_600_000), cashUsd: 332.08, equityUsd: 331.65, position: position(btc, { contracts: 0.00368 * 50_000 }) },
      bee3: { ...freshBee("bee3", 333, NOW - 3_600_000), cashUsd: 332.17, equityUsd: 331.39, position: position(sol, { contracts: 165 }) },
    };
    for (const b of Object.values(existing)) db.saveBee(b, NOW);

    let mv = v();
    let clock = NOW;
    const feed = { lastRefreshAt: NOW, view: () => mv, refresh: async () => {}, refreshTickers: async () => {} } as unknown as MarketFeed;
    let hawkCalls = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const isHawk = body.messages[0]!.content.startsWith("You are Hawk");
      if (isHawk) hawkCalls++;
      const content = isHawk ? buy({ size_pct: 50, take_profit_pct: 4, stop_loss_pct: 2 }) : "{}"; // menu bees: off-menu, they hold
      return new Response(JSON.stringify({ model: "x", usage: { prompt_tokens: 1200, completion_tokens: 90, cost: 0.0004 }, choices: [{ message: { content } }] }));
    };
    const jev = new Jev({ ...cfg.jev, fetchImpl, now: () => clock });
    const exec = new SimExecutor(() => mv, cfg.risk.takerFeeRate, () => clock);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus: new EventBus(db), alerts: new Alerts(undefined), now: () => clock });
    await engine.start();
    try {
      // The three are restored exactly; Hawk starts fresh at $333.
      for (const id of ["bee1", "bee2", "bee3"] as const) {
        const { cashUsd, equityUsd, position: pos, totals, dayStartEquityUsd } = existing[id];
        expect(engine.bees[id]).toMatchObject({ cashUsd, equityUsd, position: pos, totals, dayStartEquityUsd });
      }
      expect(engine.bees.bee4).toMatchObject({ cashUsd: 333, equityUsd: 333, position: null });

      await engine.tick();
      const p = engine.bees.bee4.position!;
      expect(hawkCalls).toBe(1);
      expect(p).toMatchObject({ coin: "SOL", side: "long", invalidation: "SOL loses 140" });
      expect(p.contracts * (1 / 100) * p.entryPx).toBeLessThanOrEqual(333);
      expect(p.entryPx).toBeCloseTo(sol.ask, 9); // filled at the best ask
      expect(p.takeProfitPx).toBeCloseTo(p.entryPx * 1.04, 9);
      expect(p.stopPx).toBeCloseTo(p.entryPx * 0.98, 9);
      expect(engine.bees.bee4.tradesToday).toBe(1);
      expect(engine.bees.bee4.totals.feesUsd).toBeCloseTo(p.contracts * (1 / 100) * p.entryPx * 0.005, 9);
      const row = db.raw.prepare(`SELECT menu_json AS m, choice FROM decisions WHERE bee = 'bee4' ORDER BY id DESC LIMIT 1`).get() as { m: string; choice: string };
      expect(JSON.parse(row.m).hawk).toMatchObject({ action: "BUY", coin: "SOL", size_pct: 50 });
      const snap = engine.snapshot();
      expect(snap.bees.map((b) => b.bee)).toEqual(["bee1", "bee2", "bee3", "bee4"]);
      expect((snap.bees[3] as { hawk?: { answer: HawkAnswer } }).hawk?.answer.take_profit_pct).toBe(4);

      // SOL runs 5%: code takes Jev's profit before asking Jev anything.
      clock += 60_000;
      mv = view([btc, coin("SOL", {}, 105)]);
      await engine.tick();
      expect(hawkCalls).toBe(1);
      expect(engine.bees.bee4.position).toBeNull();
      expect(engine.bees.bee4.totals.realisedUsd).toBeGreaterThan(0);
      const exit = db.raw.prepare(`SELECT forced_by AS f FROM decisions WHERE bee = 'bee4' ORDER BY id DESC LIMIT 1`).get() as { f: string };
      expect(exit.f).toBe("take_profit");
    } finally {
      engine.stop();
    }
  });
});
