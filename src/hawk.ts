// Fork: Hawk, the fourth bot (bee4). Idea: let Jev decide, and don't hold it back.
//
// The other three bots are Jev on a short leash: code builds a small menu, code sizes the trade and sets the stop.
// Hawk is Jev with full control, like the Alpha Arena contest: every tick Jev gets a compact report of the whole
// gated Crypto.com universe plus Hawk's own books, and answers with a complete decision in strict JSON
// (action, coin, size, take-profit, stop-loss, invalidation, reason). Code only executes, and enforces the physical
// limits:
//   - paper only, buy-only spot, no leverage: notional never exceeds Hawk's equity (after the fee), no shorts
//   - paper fills at best bid/ask with the same taker fee as the others (the SimExecutor)
//   - Jev's take-profit and stop-loss are executed by code every tick
//   - invalid JSON, an off-universe coin or a timeout means Hawk holds
// No trade cap, no fee budget, no cooldown, no forced entries, no "never flat" rule. Its only limit is the shared
// daily Jev cap (JEV_DAILY_USD_CAP). Hawk may sit out if Jev chooses.
//
// Everything in this file is pure (no I/O, no clock) so it is fully testable; engine.ts does the calling.
import { positionNotional, r2 } from "./bees/common.js";
import { coinOf, type Action, type BeeState, type Position } from "./bees/types.js";
import type { MarketView } from "./market/types.js";

export const HAWK_ACTIONS = ["BUY", "HOLD", "SELL", "SWITCH"] as const;
export type HawkAction = (typeof HAWK_ACTIONS)[number];

export const HAWK_SIZE_MIN_PCT = 5;
export const HAWK_SIZE_MAX_PCT = 100;
/** Sanity bounds on Jev's exit plan (a stop at or past 100% can never fire on a long; a 10x target is not a plan). */
export const HAWK_MAX_TP_PCT = 1000;
export const HAWK_MAX_SL_PCT = 99;
const MAX_TEXT = 280;

/** Jev's complete answer, validated. Numbers are null when the action does not use them. */
export interface HawkAnswer {
  action: HawkAction;
  coin: string | null;
  size_pct: number | null;
  take_profit_pct: number | null;
  stop_loss_pct: number | null;
  invalidation: string;
  reason: string;
}

export type HawkParse = { ok: true; answer: HawkAnswer; clamped: string | null } | { ok: false; code: "BAD_JSON" | "BAD_ACTION" | "OFF_UNIVERSE" | "BAD_SIZE" | "BAD_EXIT_PLAN"; message: string };

export const HAWK_SYSTEM_PROMPT = [
  "You are Hawk, an autonomous crypto spot trader with full control of your own paper account ($333 start).",
  "Every minute you get a market report of every tradable coin plus your own books, and you answer with your complete decision.",
  "Rules of the venue (physical, not advice): spot only, BUY-ONLY (no shorting), no leverage, one coin held at a time,",
  "every fill pays a 0.50% taker fee at the best bid/ask, so a round trip costs about 1%.",
  "Code executes your take-profit and stop-loss every minute. Nothing else is decided for you: you pick the coin, the size,",
  "the exit plan, and whether to be in the market at all. Sitting out (HOLD while flat) is allowed.",
  "Actions: BUY = open a position when flat, or buy more of the coin you already hold (size_pct is the TOTAL target share of equity;",
  "take_profit_pct and stop_loss_pct replace the exit plan, measured from the new average entry). SELL = close everything.",
  "SWITCH = sell what you hold and buy another coin. HOLD = do nothing.",
  "Reply with ONLY one JSON object, no prose, exactly these keys:",
  '{"action":"BUY|HOLD|SELL|SWITCH","coin":"<ticker from coins, e.g. SOL, or null>","size_pct":<5-100 or null>,',
  '"take_profit_pct":<percent above entry, e.g. 4, or null>,"stop_loss_pct":<percent below entry, e.g. 2, or null>,',
  '"invalidation":"<short: what would make you give up this idea>","reason":"<short>"}',
  "BUY and SWITCH need coin, size_pct, take_profit_pct and stop_loss_pct. coin must be one of the tickers in coins.rows.",
].join(" ");

/** What Jev sees about one coin: the same kind of stats the other bots get, for every coin in the gated universe. */
const COIN_COLS = ["px", "r1h_pct", "r24h_pct", "r7d_pct", "rsi14", "atr_pct", "bbw_pct", "macd_pct", "vol_musd", "spread_bp"] as const;

export interface HawkBooks {
  bee: BeeState;
  view: MarketView;
  startEquityUsd: number;
  takerFeeRate: number;
  now: number;
  /** Hawk's previous answer (so Jev keeps its own thread). */
  last: HawkAnswer | null;
}

/** The market report + Hawk's books, as one compact JSON object (the user message). */
export function hawkReport(b: HawkBooks): Record<string, unknown> {
  const { bee, view, now } = b;
  const rows: Record<string, Array<number | null>> = {};
  for (const id of view.gated) {
    const s = view.stats.get(id);
    if (!s) continue;
    rows[s.coin] = [
      Number(s.mid.toPrecision(6)),
      r2(s.ret1hPct, 2),
      r2(s.ret24hPct, 2),
      r2(s.ret7dPct, 1),
      r2(s.rsi14, 0),
      r2(s.atr14Pct, 2),
      r2(s.bbWidthPct, 2),
      r2(s.macdHistPct, 3),
      r2(s.vol24hUsd / 1e6, 1),
      r2(s.spreadBp, 1),
    ];
  }
  const p = bee.position;
  const s = p ? view.stats.get(p.instId) : undefined;
  const inst = p ? view.instruments.get(p.instId) : undefined;
  const posUsd = p && s && inst ? positionNotional(p, s.mid, inst.ctVal) : 0;
  const d = new Date(now);
  const me: Record<string, unknown> = {
    equity_usd: r2(bee.equityUsd),
    cash_usd: r2(bee.equityUsd - posUsd),
    pnl_usd: r2(bee.equityUsd - b.startEquityUsd),
    pnl_pct: r2(((bee.equityUsd - b.startEquityUsd) / b.startEquityUsd) * 100),
    fee_rate_pct: r2(b.takerFeeRate * 100, 2),
    fees_today_usd: r2(bee.feesTodayUsd),
    trades_today: bee.tradesToday,
    position: p
      ? {
          coin: p.coin,
          usd: r2(posUsd),
          entry: Number(p.entryPx.toPrecision(6)),
          mark: s ? Number(s.mid.toPrecision(6)) : null,
          upl_usd: r2(bee.uplUsd),
          upl_pct: s ? r2(((s.mid - p.entryPx) / p.entryPx) * 100) : null,
          size_pct_of_equity: bee.equityUsd > 0 ? r2((posUsd / bee.equityUsd) * 100, 0) : null,
          take_profit_px: p.takeProfitPx ?? null,
          stop_loss_px: p.stopPx,
          held_min: Math.round((now - p.openedAt) / 60_000),
          invalidation: p.invalidation ?? "",
        }
      : "flat",
  };
  if (!p && bee.flatSince !== null) me.flat_min = Math.round((now - bee.flatSince) / 60_000);
  if (b.last) me.last_answer = { action: b.last.action, coin: b.last.coin, reason: b.last.reason };
  return {
    utc: `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    me,
    coins: { cols: COIN_COLS, rows, note: "px USD mid; r = % return; rsi14/atr/bbw/macd on 15m bars; vol_musd = 24h USD volume in millions" },
  };
}

/** "SOL", "sol", "SOL_USD", "SOL-USD", "SOL/USD" -> "SOL". */
function normCoin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase().replace(/[-_/]USDT?$/, "");
  return /^[A-Z0-9]{1,15}$/.test(c) ? c : null;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT) : "");

/**
 * Parse and validate Jev's reply. `universe` is the tradable coin tickers (e.g. ["BTC", "SOL"]).
 * Fail-closed: anything malformed is an error and the engine holds. size_pct outside 5-100 is clamped, not refused
 * (the engine also clamps the dollar size to equity).
 */
export function parseHawkReply(raw: string, universe: string[]): HawkParse {
  let j: Record<string, unknown>;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no object");
    const v = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    j = v as Record<string, unknown>;
  } catch {
    return { ok: false, code: "BAD_JSON", message: "reply was not a JSON object" };
  }
  const action = typeof j.action === "string" ? (j.action.trim().toUpperCase() as HawkAction) : null;
  if (!action || !HAWK_ACTIONS.includes(action)) return { ok: false, code: "BAD_ACTION", message: `action must be one of ${HAWK_ACTIONS.join("/")}` };

  const coin = normCoin(j.coin);
  const entering = action === "BUY" || action === "SWITCH";
  if (entering && (!coin || !universe.includes(coin))) return { ok: false, code: "OFF_UNIVERSE", message: `coin ${String(j.coin)} is not in the tradable universe` };
  if (action === "SELL" && j.coin !== null && j.coin !== undefined && j.coin !== "" && !coin) return { ok: false, code: "OFF_UNIVERSE", message: "unreadable coin" };

  let size = numOrNull(j.size_pct);
  let tp = numOrNull(j.take_profit_pct);
  let sl = numOrNull(j.stop_loss_pct);
  let clamped: string | null = null;
  if (entering) {
    if (size === null || size <= 0) return { ok: false, code: "BAD_SIZE", message: "size_pct must be a positive number" };
    const c = Math.max(HAWK_SIZE_MIN_PCT, Math.min(HAWK_SIZE_MAX_PCT, size));
    if (c !== size) clamped = `size_pct ${size} clamped to ${c}`;
    size = c;
    if (tp === null || tp <= 0 || tp > HAWK_MAX_TP_PCT) return { ok: false, code: "BAD_EXIT_PLAN", message: `take_profit_pct must be in (0, ${HAWK_MAX_TP_PCT}]` };
    if (sl === null || sl <= 0 || sl > HAWK_MAX_SL_PCT) return { ok: false, code: "BAD_EXIT_PLAN", message: `stop_loss_pct must be in (0, ${HAWK_MAX_SL_PCT}]` };
  } else {
    size = null;
    tp = null;
    sl = null;
  }
  return {
    ok: true,
    answer: { action, coin: entering || action === "SELL" ? coin : (coin ?? null), size_pct: size, take_profit_pct: tp, stop_loss_pct: sl, invalidation: text(j.invalidation), reason: text(j.reason) },
    clamped,
  };
}

export interface HawkPlanInput {
  answer: HawkAnswer;
  bee: BeeState;
  view: MarketView;
  takerFeeRate: number;
  dataStale: boolean;
}

export interface HawkPlan {
  action: Action;
  /** Why the answer was not executed as-is (null when it was, or when Jev held). */
  vetoedBy: string | null;
  /** A Jev-ordered trade (shown as "trades today"; there is no cap). */
  countsAsTrade: boolean;
  status: string;
}

/** Most Hawk can put into one coin: its equity, less the entry fee (spot, no leverage). */
export function hawkMaxNotional(equityUsd: number, takerFeeRate: number): number {
  return Math.max(0, equityUsd / (1 + takerFeeRate));
}

/** The instId of a coin in the gated universe. */
export function instIdFor(view: MarketView, coin: string): string | null {
  return view.gated.find((id) => coinOf(id) === coin) ?? null;
}

/**
 * Turn Jev's answer into an action. Only physical limits apply: buy-only, notional <= equity, a price to trade at,
 * and the exchange's minimum order.
 */
export function planHawk(i: HawkPlanInput): HawkPlan {
  const { answer: a, bee, view } = i;
  const p = bee.position;
  const hold = (status: string, vetoedBy: string | null = null): HawkPlan => ({ action: { kind: "none" }, vetoedBy, countsAsTrade: false, status });
  const label = `${a.action}${a.coin ? ` ${a.coin}` : ""}`;

  if (a.action === "HOLD") return hold(p ? `holding ${p.coin}` : "sitting out");
  if (i.dataStale) return hold(`wanted ${label}, market data is stale`, "stale_market_data");

  if (a.action === "SELL") {
    if (!p) return hold("SELL while flat: nothing to sell", "nothing_to_sell");
    if (a.coin && a.coin !== p.coin) return hold(`wanted SELL ${a.coin} but holds ${p.coin}`, "sell_wrong_coin");
    return { action: { kind: "close", reason: "jev_sell" }, vetoedBy: null, countsAsTrade: true, status: `SELL ${p.coin}` };
  }

  const coin = a.coin!;
  const instId = instIdFor(view, coin);
  const s = instId ? view.stats.get(instId) : undefined;
  const inst = instId ? view.instruments.get(instId) : undefined;
  if (!instId || !s || !inst) return hold(`wanted ${label}, no price for ${coin}`, "no_market_data");
  const minUsd = inst.minSz * inst.ctVal * s.ask;
  const cap = hawkMaxNotional(bee.equityUsd, i.takerFeeRate);
  const target = Math.min((a.size_pct! / 100) * bee.equityUsd, cap);

  if (p && p.coin === coin) {
    if (a.action === "SWITCH") return hold(`SWITCH to ${coin}, which it already holds`, "switch_to_same");
    // BUY on the held coin: top up to the target size (the new exit plan is applied either way, see engine).
    const held = positionNotional(p, s.mid, inst.ctVal);
    const add = Math.min(target - held, cap - held);
    if (add < minUsd) return hold(`already at ${Math.round((held / Math.max(bee.equityUsd, 1e-9)) * 100)}% in ${coin}; exit plan updated`, "already_at_size");
    return { action: { kind: "add", notionalUsd: add }, vetoedBy: null, countsAsTrade: true, status: `BUY more ${coin} +$${add.toFixed(0)}` };
  }
  if (p && a.action === "BUY") return hold(`wanted BUY ${coin} while holding ${p.coin} (that is a SWITCH)`, "holding_other_coin");

  // Open (BUY while flat, or SWITCH while flat) or switch: after selling, equity drops by the exit fee.
  const exitFee = p ? positionNotional(p, s.mid, inst.ctVal) * i.takerFeeRate : 0;
  const notional = p ? Math.min(target, hawkMaxNotional(bee.equityUsd - exitFee, i.takerFeeRate)) : target;
  if (notional < minUsd) return hold(`wanted ${label}, $${notional.toFixed(2)} is below ${coin}'s minimum order`, "below_min_size");
  if (p) return { action: { kind: "switch", instId, side: "long", notionalUsd: notional }, vetoedBy: null, countsAsTrade: true, status: `SWITCH ${p.coin} -> ${coin} $${notional.toFixed(0)}` };
  return { action: { kind: "open", instId, side: "long", notionalUsd: notional }, vetoedBy: null, countsAsTrade: true, status: `BUY ${coin} $${notional.toFixed(0)}` };
}

/** Code-side exit, every tick: Jev's take-profit or stop-loss hit at the current mid. */
export function hawkExitHit(p: Position, mid: number | undefined): "take_profit" | "stop_loss" | null {
  if (mid === undefined || !(mid > 0) || p.side !== "long") return null;
  if (p.stopPx !== null && mid <= p.stopPx) return "stop_loss";
  if (p.takeProfitPx !== null && p.takeProfitPx !== undefined && mid >= p.takeProfitPx) return "take_profit";
  return null;
}

/** Apply Jev's exit plan to a (new or topped-up) position, from its average entry. */
export function applyExitPlan(p: Position, a: HawkAnswer, ctVal: number): void {
  if (a.take_profit_pct === null || a.stop_loss_pct === null) return;
  p.takeProfitPct = a.take_profit_pct;
  p.stopLossPct = a.stop_loss_pct;
  p.takeProfitPx = p.entryPx * (1 + a.take_profit_pct / 100);
  p.stopPx = p.entryPx * (1 - a.stop_loss_pct / 100);
  p.invalidation = a.invalidation;
  p.riskUsd = p.contracts * ctVal * p.entryPx * (a.stop_loss_pct / 100);
}
