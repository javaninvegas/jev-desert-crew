// Fork: N real Hawk calls on a live Crypto.com snapshot (no orders). Prints Jev's answers, whether they parse,
// and the measured cost, tokens and latency per call. Never prints the key.
// EXCHANGE=cryptocom JEV_PROVIDER=openrouter JEV_API_KEY_FILE=... node dist/tools/hawk-check.js [N=3]
import { BREEZY_COINS } from "../bees/breezy.js";
import { coinOf } from "../bees/types.js";
import { createCdcPublicApi } from "../cdc/public.js";
import { loadConfig, STYLES } from "../config.js";
import { HAWK_SYSTEM_PROMPT, hawkReport, parseHawkReply } from "../hawk.js";
import { Jev } from "../jev.js";
import { freshBee } from "../ledger.js";
import { MarketFeed } from "../market/data.js";

const N = Math.max(1, Number(process.argv[2] ?? 3));
const cfg = loadConfig({ ...process.env, DRY_RUN: "true" });
const feed = new MarketFeed(
  createCdcPublicApi(cfg.okx.cliTimeoutMs),
  { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: false, spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)), trendCoins: [...BREEZY_COINS] },
  null,
  () => [],
);
await feed.refresh();
const view = feed.view();
const jev = new Jev({ ...cfg.jev });
const bee = freshBee("bee4", cfg.risk.startEquityUsd, Date.now() - 60_000);
const user = JSON.stringify(hawkReport({ bee, view, startEquityUsd: cfg.risk.startEquityUsd, takerFeeRate: cfg.risk.takerFeeRate, now: Date.now(), last: null }));
console.log(`universe ${view.gated.length} coins; prompt ${HAWK_SYSTEM_PROMPT.length + user.length} chars`);

let cost = 0;
let ok = 0;
const lat: number[] = [];
for (let i = 0; i < N; i++) {
  const r = await jev.askRaw(HAWK_SYSTEM_PROMPT, user, cfg.hawk);
  if (!r.ok) {
    console.log(i, "FAILED", r.reason, r.error?.code, r.error?.message, `${r.latencyMs}ms`);
    continue;
  }
  const p = parseHawkReply(r.raw, view.gated.map(coinOf));
  cost += r.costUsd;
  lat.push(r.latencyMs);
  if (p.ok) ok++;
  console.log(i, p.ok ? JSON.stringify(p.answer) : `UNPARSEABLE ${p.code}: ${r.raw.slice(0, 300)}`);
  console.log(`   $${r.costUsd.toFixed(6)} in=${r.inputTokens} out=${r.outputTokens} ${r.latencyMs}ms model=${r.model}`);
}
const n = lat.length || 1;
console.log(`\n${ok}/${N} parsed; avg $${(cost / n).toFixed(6)}/call, avg ${Math.round(lat.reduce((a, b) => a + b, 0) / n)}ms; at TICK_MS=${cfg.tickMs}: ~$${((cost / n) * (86_400_000 / cfg.tickMs)).toFixed(2)}/day for Hawk alone`);
