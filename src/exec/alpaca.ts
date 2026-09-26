// Fork: Alpaca PAPER for the Jev-in-control bots — the live crypto feed the video used, and real paper
// fills on Alpaca's own practice account. PAPER ONLY: the trading URL is hard-coded to paper-api and there is no way to
// point it at the live endpoint. Keys come from mounted files and are never logged.
import { readFileSync } from "node:fs";
import type { BeeId } from "../config.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { Executor, OrderReq, OrderResult } from "./executor.js";

const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets/v1beta3/crypto/us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "BTC_USD" (our id) <-> "BTC/USD" (Alpaca's). */
export const toAlpaca = (instId: string) => instId.replace("_", "/");

export interface LiveQuote {
  bid: number;
  ask: number;
  mid: number;
  spreadBp: number;
  /** (bid size - ask size) / total over the top 10 levels, -1..+1. Null when there is no book. */
  bookImbalance: number | null;
  ts: number;
}

function readKey(path: string): string {
  const k = readFileSync(path, "utf8").split(/\r?\n/)[0]?.trim();
  if (!k) throw new Error(`empty key file ${path}`);
  return k;
}

type Books = { orderbooks?: Record<string, { b: Array<{ p: number; s: number }>; a: Array<{ p: number; s: number }> }> };

export class AlpacaPaper {
  private headers: Record<string, string>;
  /** Coins Alpaca lets this account trade, e.g. "BTC". Loaded by init(). */
  coins = new Set<string>();

  constructor(keyIdFile: string, secretFile: string, private timeoutMs = 8_000) {
    this.headers = { "APCA-API-KEY-ID": readKey(keyIdFile), "APCA-API-SECRET-KEY": readKey(secretFile), "Content-Type": "application/json" };
  }

  private async req<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: this.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Alpaca HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return (text ? JSON.parse(text) : {}) as T;
  }

  async init(): Promise<void> {
    const acct = await this.req<{ status?: string; crypto_status?: string }>(`${PAPER}/v2/account`);
    if (acct.status !== "ACTIVE" || acct.crypto_status !== "ACTIVE") throw new Error(`Alpaca paper account not ready (${acct.status}/${acct.crypto_status})`);
    const assets = await this.req<Array<{ symbol: string; tradable: boolean }>>(`${PAPER}/v2/assets?asset_class=crypto&status=active`);
    this.coins = new Set(assets.filter((a) => a.tradable && a.symbol.endsWith("/USD")).map((a) => a.symbol.split("/")[0]!));
    log.info("alpaca paper ready", { coins: [...this.coins].sort().join(",") });
  }

  /** Live quote + top-10 book per coin (our ids in, our ids out). One request each for quotes and books. */
  async live(instIds: string[]): Promise<Map<string, LiveQuote>> {
    const out = new Map<string, LiveQuote>();
    if (instIds.length === 0) return out;
    const syms = instIds.map(toAlpaca).join(",");
    const [q, b] = await Promise.all([
      this.req<{ quotes?: Record<string, { bp: number; ap: number; t: string }> }>(`${DATA}/latest/quotes?symbols=${encodeURIComponent(syms)}`),
      this.req<Books>(`${DATA}/latest/orderbooks?symbols=${encodeURIComponent(syms)}`).catch((): Books => ({ orderbooks: {} })),
    ]);
    for (const id of instIds) {
      const s = toAlpaca(id);
      const qq = q.quotes?.[s];
      if (!qq || !(qq.bp > 0) || !(qq.ap > 0)) continue;
      const mid = (qq.bp + qq.ap) / 2;
      const book = b.orderbooks?.[s];
      let imb: number | null = null;
      if (book) {
        const bs = book.b.slice(0, 10).reduce((a, x) => a + x.s * x.p, 0);
        const as = book.a.slice(0, 10).reduce((a, x) => a + x.s * x.p, 0);
        imb = bs + as > 0 ? Number(((bs - as) / (bs + as)).toFixed(3)) : null;
      }
      out.set(id, { bid: qq.bp, ask: qq.ap, mid, spreadBp: ((qq.ap - qq.bp) / mid) * 10_000, bookImbalance: imb, ts: Date.parse(qq.t) || Date.now() });
    }
    return out;
  }

  /** Market order on the PAPER account, waits (briefly) for the fill. Sells are capped at what the account holds. */
  async market(req: OrderReq, takerFeeRate: number): Promise<OrderResult> {
    const symbol = toAlpaca(req.instId);
    try {
      let qty = req.contracts;
      if (req.side === "sell") {
        const pos = await this.req<{ qty?: string }>(`${PAPER}/v2/positions/${encodeURIComponent(symbol.replace("/", ""))}`).catch(() => ({ qty: "0" }));
        qty = Math.min(qty, Number(pos.qty ?? 0));
        if (!(qty > 0)) return { ok: false, error: { code: "ALPACA_NO_POSITION", message: `no ${symbol} held on the paper account` }, state: "rejected" };
      }
      const order = await this.req<{ id: string }>(`${PAPER}/v2/orders`, {
        method: "POST",
        body: { symbol, qty: qty.toFixed(9).replace(/0+$/, "").replace(/\.$/, ""), side: req.side, type: "market", time_in_force: "gtc", client_order_id: req.clOrdId },
      });
      for (let i = 0; i < 20; i++) {
        const o = await this.req<{ status: string; filled_qty: string; filled_avg_price: string | null; filled_at: string | null }>(`${PAPER}/v2/orders/${order.id}`);
        const filled = Number(o.filled_qty);
        if (o.status === "filled" || (filled > 0 && ["canceled", "expired", "done_for_day"].includes(o.status))) {
          const px = Number(o.filled_avg_price);
          return { ok: true, ordId: order.id, contracts: filled, avgPx: px, feeUsd: filled * px * takerFeeRate, ts: Date.parse(o.filled_at ?? "") || Date.now() };
        }
        if (["rejected", "canceled", "expired"].includes(o.status)) return { ok: false, error: { code: "ALPACA_" + o.status.toUpperCase(), message: `order ${o.status}` }, state: "rejected" };
        await sleep(300);
      }
      return { ok: false, error: { code: "ALPACA_TIMEOUT", message: "no fill within 6 s" }, state: "unknown" };
    } catch (err) {
      log.warn("alpaca order failed", { symbol, err: safeError(err) });
      return { ok: false, error: safeError(err), state: "rejected" };
    }
  }
}

/** Routes each bot's orders: the Jev-in-control bots to Alpaca paper, everyone else (Hawk) to the simulator. */
export class RoutedExecutor implements Executor {
  readonly kind = "sim" as const;
  constructor(
    private sim: Executor,
    private alpaca: AlpacaPaper,
    private useAlpaca: (bee: BeeId) => boolean,
    private takerFeeRate: number,
  ) {}
  async init(bee: BeeId) {
    await this.sim.init(bee);
  }
  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    if (!this.useAlpaca(bee)) return this.sim.market(bee, req);
    const r = await this.alpaca.market(req, this.takerFeeRate);
    // A position opened on the simulator before the switch to Alpaca is closed on the simulator (Alpaca never held it).
    if (!r.ok && r.error.code === "ALPACA_NO_POSITION" && req.side === "sell") return this.sim.market(bee, req);
    return r;
  }
  async positions() {
    return null;
  }
  async fundingBills() {
    return null;
  }
  async feesFor() {
    return null;
  }
}
