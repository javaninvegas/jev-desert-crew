// Fork: Jev in control. A yes IS the order; everything malformed holds.
import { describe, expect, it } from "vitest";
import { buyNotional, controlAsk, pctChange, pickControl, recordMids, type MidHistory } from "../src/control.js";
import type { MarketView, CoinStats, Ticker } from "../src/market/types.js";

function stat(coin: string, mid: number): CoinStats {
  return {
    instId: `${coin}_USD`, coin, last: mid, mid, bid: mid, ask: mid, spreadBp: 1, vol24hUsd: 1e9, rsi14: 50, pctB: 0.5, bbWidthPct: 1, bbMid: mid,
    atr14Pct: 0.5, macdHistPct: 0, ret1hPct: 0.1, ret24hPct: 1, ret7dPct: 5, volZ: 0, fundingPct: null, fundingZ: null, oiUsd: null, oiChg1hPct: null,
    newsZ: null, sentiment: null,
  } as CoinStats;
}
function view(stats: CoinStats[]): MarketView {
  const tickers = new Map<string, Ticker>(stats.map((s) => [s.instId, { instId: s.instId, last: s.mid, bid: s.mid, ask: s.mid, mid: s.mid, spreadBp: 1, vol24hUsd: 1e9, open24h: s.mid, ts: 0 }]));
  return { ts: 0, instruments: new Map(), tickers, stats: new Map(stats.map((s) => [s.instId, s])), gated: stats.map((s) => s.instId), spreadBlocked: [], newsAvailable: false };
}

describe("Jev in control", () => {
  const v = view([stat("BTC", 84000), stat("ETH", 2700)]);
  const qFlat = { buy_BTC: "Buy BTC right now?", buy_ETH: "Buy ETH right now?" };

  it("the highest yes above 0.5 is the buy", () => {
    const p = pickControl({ buy_BTC: 0.62, buy_ETH: 0.81 }, qFlat, v, false);
    expect(p).toMatchObject({ kind: "buy", coin: "ETH", instId: "ETH_USD" });
  });
  it("no yes above 0.5 holds", () => {
    expect(pickControl({ buy_BTC: 0.5, buy_ETH: 0.2 }, qFlat, v, false).kind).toBe("hold");
  });
  it("malformed or out-of-range answers never trade", () => {
    expect(pickControl({ buy_BTC: 1.7, buy_ETH: "0.9" }, qFlat, v, false).kind).toBe("hold");
    expect(pickControl({}, qFlat, v, false).kind).toBe("hold");
    expect(pickControl({ buy_DOGE: 0.99 }, qFlat, v, false).kind).toBe("hold"); // not asked
  });
  it("holding: sell yes > 0.5 sells, otherwise keeps", () => {
    const q = { sell: "Sell the BTC you hold right now?" };
    expect(pickControl({ sell: 0.7 }, q, v, true).kind).toBe("sell");
    expect(pickControl({ sell: 0.3 }, q, v, true).kind).toBe("hold");
    expect(pickControl({}, q, v, true).kind).toBe("hold");
  });
  it("flat asks one buy question per candidate; holding asks only sell", () => {
    const hist: MidHistory = new Map();
    const flat = controlAsk({ strategy: "s", view: v, hist, candidates: ["BTC_USD", "ETH_USD"], position: null, cashUsd: 333, equityUsd: 333, now: 0 });
    expect(Object.keys(flat.questions)).toEqual(["buy_BTC", "buy_ETH"]);
    const pos = { instId: "BTC_USD", coin: "BTC", side: "long", contracts: 0.001, entryPx: 84000, openedAt: 0, stopPx: 82000 } as never;
    const held = controlAsk({ strategy: "s", view: v, hist, candidates: ["BTC_USD", "ETH_USD"], position: pos, cashUsd: 0, equityUsd: 333, now: 60_000 });
    expect(Object.keys(held.questions)).toEqual(["sell"]);
  });
  it("second-level price changes come from the recorded mids", () => {
    const hist: MidHistory = new Map();
    const a = view([stat("BTC", 100)]);
    recordMids(hist, a, ["BTC_USD"], 0);
    const b = view([stat("BTC", 101)]);
    recordMids(hist, b, ["BTC_USD"], 30_000);
    expect(pctChange(hist, "BTC_USD", 30_000, 30_000)).toBe(1);
    expect(pctChange(hist, "BTC_USD", 30_000, 60_000)).toBeNull(); // no sample that old yet
  });
  it("spends only the bot's own cash, fee included", () => {
    const n = buyNotional(333, 0.005);
    expect(n * 1.005).toBeLessThanOrEqual(333);
    expect(buyNotional(0, 0.005)).toBe(0);
  });
});
