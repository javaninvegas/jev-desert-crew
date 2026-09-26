// Fork: Crypto.com Exchange PUBLIC market data (no keys), shaped like the OKX PublicApi so the rest of the
// engine is unchanged. Spot USD pairs only ("BTC_USD"): one contract = one coin (ctVal 1), no funding, no open interest.
import type { PublicApi } from "../okx/public.js";
import type { Candle, Instrument, Ticker } from "../market/types.js";

const BASE = "https://api.crypto.com/exchange/v1/public";
const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const TF: Record<"15m" | "1H" | "4H", { tf: string; ms: number }> = {
  "15m": { tf: "15m", ms: 15 * 60_000 },
  "1H": { tf: "1h", ms: 3_600_000 },
  "4H": { tf: "4h", ms: 4 * 3_600_000 },
};
// Dollar-pegged coins are not something to trade against USD.
const STABLE = new Set(["USDT", "USDC", "PYUSD", "DAI", "TUSD", "USDP", "FDUSD", "USDE", "USD1", "RLUSD", "EURC"]);

type Row = Record<string, unknown>;

export function createCdcPublicApi(timeoutMs = 15_000): PublicApi {
  const cache = new Map<string, { at: number; p: Promise<unknown> }>();
  const get = <T>(path: string, query: Record<string, string | number>, ttlMs: number): Promise<T> => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const url = `${BASE}/${path}${qs ? `?${qs}` : ""}`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
    const p = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error(`Crypto.com HTTP ${res.status}`), { status: res.status });
      const j = (await res.json()) as { code?: number; result?: { data?: T } };
      if (j.code !== 0 || !j.result?.data) throw new Error(`Crypto.com error code ${j.code}`);
      return j.result.data;
    })();
    cache.set(url, { at: Date.now(), p });
    p.catch(() => cache.delete(url));
    return p;
  };

  return {
    async instruments() {
      const rows = await get<Row[]>("get-instruments", {}, 10_000);
      const out: Instrument[] = [];
      for (const r of rows) {
        if (r.inst_type !== "CCY_PAIR" || r.quote_ccy !== "USD" || r.tradable !== true) continue;
        const coin = String(r.base_ccy);
        const qty = num(r.qty_tick_size);
        out.push({
          instId: String(r.symbol),
          coin,
          kind: STABLE.has(coin) ? "unknown" : r.product_type === "DIGITAL_CURRENCIES" ? "crypto" : "unknown",
          ctVal: 1,
          lotSz: qty,
          minSz: qty,
          tickSz: num(r.price_tick_size),
          state: "live",
        });
      }
      return out;
    },
    async tickers() {
      const rows = await get<Row[]>("get-tickers", {}, 900);
      const out = new Map<string, Ticker>();
      for (const r of rows) {
        const id = String(r.i ?? "");
        if (!/^[A-Z0-9]+_USD$/.test(id)) continue;
        const last = num(r.a);
        const bid = num(r.b);
        const ask = num(r.k);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
        const chg = num(r.c);
        out.set(id, {
          instId: id,
          last,
          bid,
          ask,
          mid,
          spreadBp: bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : Infinity,
          vol24hUsd: num(r.vv),
          open24h: Number.isFinite(chg) && chg > -1 ? last / (1 + chg) : NaN,
          ts: num(r.t),
        });
      }
      return out;
    },
    async candles(instId, bar, limit) {
      const { tf, ms } = TF[bar];
      const rows = await get<Row[]>("get-candlestick", { instrument_name: instId, timeframe: tf, count: Math.min(limit, 300) }, 10_000);
      const now = Date.now();
      const out: Candle[] = rows.map((r) => {
        const c = num(r.c);
        return { ts: num(r.t), o: num(r.o), h: num(r.h), l: num(r.l), c, volUsd: num(r.v) * c, confirmed: num(r.t) + ms <= now };
      });
      return out.sort((a, b) => a.ts - b.ts);
    },
    async openInterest() {
      return new Map<string, number>();
    },
    async funding() {
      return { rate: 0, nextFundingTime: NaN };
    },
    async fundingHistory() {
      return [];
    },
  };
}
