// Fork: "Jev in control" for Coyote / Tortoise / Roadrunner 
//
// Every tick the state goes before Jev as binary yes/no questions whose answers ARE the orders:
//   flat    -> "Buy <coin> now?" for each of the bot's coins (1-3), one call
//   holding -> "Sell the <coin> you hold now?", one call
// A yes (> 0.5) executes; if several buys say yes, the highest wins. Anything missing or malformed holds.
// Code keeps only the physical limits (paper, own cash, long-only, the stop-loss set at entry, the daily Jev spend cap).
// Pure functions only: no I/O here, so every rule is unit-tested.
import type { StyleId } from "./settings.js";
import type { CoinStats, MarketView } from "./market/types.js";
import type { Position } from "./bees/types.js";
import type { LiveQuote } from "./exec/alpaca.js";

export const YES = 0.5;
export const MAX_COINS = 3;
const HISTORY_MS = 6 * 60_000;

/** instId -> [ts, mid] samples, newest last, kept for the last few minutes (fed every tick). */
export type MidHistory = Map<string, Array<[number, number]>>;

export function recordMids(hist: MidHistory, view: MarketView, instIds: Iterable<string>, now: number): void {
  for (const id of instIds) {
    const t = view.tickers.get(id);
    if (!t || !(t.mid > 0)) continue;
    const arr = hist.get(id) ?? [];
    arr.push([now, t.mid]);
    while (arr.length && now - arr[0]![0] > HISTORY_MS) arr.shift();
    hist.set(id, arr);
  }
}

/** % change of the mid over the last `agoMs`, or null when there is no sample that old yet. */
export function pctChange(hist: MidHistory, instId: string, now: number, agoMs: number): number | null {
  const arr = hist.get(instId);
  if (!arr || arr.length < 2) return null;
  const cur = arr[arr.length - 1]![1];
  let past: number | null = null;
  for (const [ts, mid] of arr) {
    if (now - ts >= agoMs) past = mid;
    else break;
  }
  return past && past > 0 ? Number((((cur - past) / past) * 100).toFixed(3)) : null;
}

/** The bot's coins, from its style: Coyote BTC/ETH/SOL, Tortoise BTC/ETH, Roadrunner the week's top 3 movers. */
export function candidateInstIds(style: StyleId | "hawk", view: MarketView): string[] {
  const stats = [...view.stats.values()];
  const byCoin = (coins: string[]) => coins.map((c) => stats.find((s) => s.coin === c)?.instId).filter((x): x is string => !!x);
  if (style === "bizzy") return byCoin(["BTC", "ETH", "SOL"]);
  if (style === "breezy") return byCoin(["BTC", "ETH"]);
  const gated = new Set(view.gated);
  return stats
    .filter((s) => gated.has(s.instId) && s.ret7dPct !== null)
    .sort((a, b) => (b.ret7dPct ?? 0) - (a.ret7dPct ?? 0))
    .slice(0, MAX_COINS)
    .map((s) => s.instId);
}

const r = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function coinRow(s: CoinStats, hist: MidHistory, now: number, live?: LiveQuote) {
  return {
    px: live ? Number(live.mid.toPrecision(8)) : s.mid,
    bid: live ? live.bid : s.bid,
    ask: live ? live.ask : s.ask,
    spread_bp: r(live ? live.spreadBp : s.spreadBp, 1),
    book_imbalance: live ? live.bookImbalance : null,
    chg_5s_pct: pctChange(hist, s.instId, now, 5_000),
    chg_30s_pct: pctChange(hist, s.instId, now, 30_000),
    chg_1m_pct: pctChange(hist, s.instId, now, 60_000),
    chg_5m_pct: pctChange(hist, s.instId, now, 5 * 60_000),
    ret_1h_pct: r(s.ret1hPct),
    ret_24h_pct: r(s.ret24hPct),
    ret_7d_pct: r(s.ret7dPct),
    rsi14_15m: r(s.rsi14, 1),
    atr_15m_pct: r(s.atr14Pct),
    volume_z: r(s.volZ),
  };
}

export interface ControlInput {
  strategy: string;
  view: MarketView;
  hist: MidHistory;
  candidates: string[];
  position: Position | null;
  cashUsd: number;
  equityUsd: number;
  now: number;
  /** Alpaca live quotes/books per instId, when the bots trade on Alpaca paper. */
  live?: Map<string, LiveQuote>;
}

/** The state Jev sees (numbers only, all computed by code) and the yes/no questions whose answers are the orders. */
export function controlAsk(i: ControlInput): { state: Record<string, unknown>; questions: Record<string, string> } {
  const questions: Record<string, string> = {};
  const market: Record<string, unknown> = {};
  const p = i.position;
  if (p) {
    const s = i.view.stats.get(p.instId);
    if (s) market[p.coin] = coinRow(s, i.hist, i.now, i.live?.get(p.instId));
    questions.sell = `Sell the ${p.coin} you hold right now?`;
  } else {
    for (const id of i.candidates) {
      const s = i.view.stats.get(id);
      if (!s) continue;
      market[s.coin] = coinRow(s, i.hist, i.now, i.live?.get(id));
      questions[`buy_${s.coin}`] = `Buy ${s.coin} right now?`;
    }
  }
  const mid = p ? (i.live?.get(p.instId)?.mid ?? i.view.stats.get(p.instId)?.mid) : undefined;
  const state: Record<string, unknown> = {
    strategy: i.strategy,
    cash_usd: r(i.cashUsd),
    equity_usd: r(i.equityUsd),
    position: p
      ? {
          coin: p.coin,
          entry_px: p.entryPx,
          pnl_pct: mid ? r(((mid - p.entryPx) / p.entryPx) * 100) : null,
          minutes_held: Math.round((i.now - p.openedAt) / 60_000),
          stop_px: p.stopPx,
        }
      : null,
    market,
  };
  return { state, questions };
}

export type ControlPick = { kind: "buy"; instId: string; coin: string; yes: number } | { kind: "sell"; yes: number } | { kind: "hold"; why: string };

/** Jev's yes/no answers -> the order. Fails closed: missing, non-numeric or out-of-range answers never trade. */
export function pickControl(answers: Record<string, unknown>, questions: Record<string, string>, view: MarketView, holding: boolean): ControlPick {
  const prob = (k: string): number | null => {
    const v = answers[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  };
  if (holding) {
    const y = prob("sell");
    if (y === null) return { kind: "hold", why: "no valid answer to sell?" };
    return y > YES ? { kind: "sell", yes: y } : { kind: "hold", why: `Jev: keep holding (sell yes ${y.toFixed(2)})` };
  }
  let best: { coin: string; yes: number } | null = null;
  for (const k of Object.keys(questions)) {
    if (!k.startsWith("buy_")) continue;
    const y = prob(k);
    if (y === null) continue;
    if (!best || y > best.yes) best = { coin: k.slice(4), yes: y };
  }
  if (!best) return { kind: "hold", why: "no valid answers to buy?" };
  if (!(best.yes > YES)) return { kind: "hold", why: `Jev: no buy (best ${best.coin} yes ${best.yes.toFixed(2)})` };
  const s = [...view.stats.values()].find((x) => x.coin === best!.coin);
  if (!s) return { kind: "hold", why: `no market data for ${best.coin}` };
  return { kind: "buy", instId: s.instId, coin: best.coin, yes: best.yes };
}

/** Spend the bot's own cash (fee included, small buffer for the spread). */
export function buyNotional(cashUsd: number, takerFeeRate: number): number {
  return Math.max(0, (cashUsd / (1 + takerFeeRate)) * 0.995);
}
