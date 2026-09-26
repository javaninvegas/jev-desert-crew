import { readFileSync } from "node:fs";
import { z } from "zod";
import { SLOT_STYLE_INFO, STYLES, type Settings, type SlotStyle, type StyleId } from "./settings.js";

/** Four bee slots. bee1-bee3 trade one of the three styles (settings.ts); two bees may share a style.
 *  Fork: bee4 is Hawk, Jev with free rein (src/hawk.ts). It is always Hawk and never comes from Setup. */
export const BEES = ["bee1", "bee2", "bee3", "bee4"] as const;
export type BeeId = (typeof BEES)[number];
/** The slots the Setup page designs (Hawk is not one of them). */
export const SETUP_SLOTS = ["bee1", "bee2", "bee3"] as const satisfies readonly BeeId[];
export { STYLES, type StyleId, type SlotStyle };

/** With no Setup file (settings only from .env), the bees are the original three, plus Hawk. */
const DEFAULT_SLOTS: Record<BeeId, SlotStyle> = { bee1: "bizzy", bee2: "breezy", bee3: "boozy", bee4: "hawk" };
/** Typed as the only acknowledgement that unlocks MODE=live. */
export const LIVE_ACK_PHRASE = "I-ACCEPT-REAL-MONEY-RISK";

export type Mode = "dry" | "demo" | "live";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a number" });
        return z.NEVER;
      }
      return n;
    });
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));
const opt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

// Per-style knobs: BIZZY_* = Breakout, BREEZY_* = Trend, BOOZY_* = Momentum. Every bee on that style uses them.
const perStyle = (prefix: string, d: { trades: number; fee: number; spread: number; cooldown: number; stopAtr: number; maxFlat: number }) => ({
  [`${prefix}_MAX_TRADES_PER_DAY`]: num(d.trades),
  [`${prefix}_FEE_BUDGET_USD_DAY`]: num(d.fee),
  [`${prefix}_SPREAD_GATE_BPS`]: num(d.spread),
  [`${prefix}_COOLDOWN_MINUTES`]: num(d.cooldown),
  [`${prefix}_STOP_ATR_MULT`]: num(d.stopAtr),
  [`${prefix}_MAX_FLAT_MINUTES`]: num(d.maxFlat),
});
// Per-bee OKX keys (demo or live only): BEE1_OKX_API_KEY, BEE1_OKX_DEMO_API_KEY, ...
const perSlot = (prefix: string) => ({
  [`${prefix}_OKX_API_KEY`]: opt,
  [`${prefix}_OKX_API_SECRET`]: opt,
  [`${prefix}_OKX_API_PASSPHRASE`]: opt,
  [`${prefix}_OKX_DEMO_API_KEY`]: opt,
  [`${prefix}_OKX_DEMO_API_SECRET`]: opt,
  [`${prefix}_OKX_DEMO_API_PASSPHRASE`]: opt,
});

const EnvSchema = z.object({
  // DRY_RUN=true (the default) forces MODE=dry whatever MODE says. Going to demo or live needs both DRY_RUN=false and MODE set.
  DRY_RUN: bool(true),
  MODE: z.enum(["dry", "demo", "live"]).optional().default("dry"),

  TYPESAFE_API_KEY: opt,
  // Fork: "openrouter" calls typesafe/jev-router through OpenRouter; the key is read from JEV_API_KEY_FILE
  // (a mounted secret file) so it never sits in the environment or `docker inspect`.
  JEV_PROVIDER: z.enum(["typesafe", "openrouter"]).optional().default("typesafe"),
  JEV_API_KEY_FILE: opt,
  // Fork: native Jev through Vercel AI Gateway's TypeSafe-compatible API (JEV_MODEL=typesafe-ai/jev).
  JEV_BASE_URL: opt,
  // Fork: Hawk's free-form call stays on OpenRouter's typesafe/jev-router, with its own key file.
  HAWK_OPENROUTER_KEY_FILE: opt,
  HAWK_MODEL: str("typesafe/jev-router"),
  // Fork: menu-bee fallback when native Jev is busy = a local Ollama model.
  JEV_LOCAL_URL: opt,
  JEV_LOCAL_MODEL: str("qwen3.6:35b-a3b"),
  JEV_LOCAL_TIMEOUT_MS: num(15_000),
  // Fork: Jev in control of Coyote/Tortoise/Roadrunner (src/control.ts).
  CONTROL_MODE: bool(false),
  // The slow local-model fallback is used at most this often per bot; ticks in between hold while native Jev is busy.
  CONTROL_LOCAL_EVERY_MS: num(30_000),
  // Hawk keeps its own slower cadence (OpenRouter free-form call, ~2-4 s, ~$0.0005) even when TICK_MS is fast.
  HAWK_EVERY_MS: num(60_000),
  // Fork: Alpaca PAPER for the Jev-in-control bots (live feed + paper fills). Keys from mounted files.
  ALPACA_KEY_ID_FILE: opt,
  ALPACA_SECRET_FILE: opt,
  ALPACA_TAKER_FEE_RATE: num(0.0025),
  JEV_MODEL: str("jev-1.13.0"),
  JEV_TIMEOUT_MS: num(2000),
  JEV_DAILY_USD_CAP: num(2),
  JEV_USD_PER_MTOK: num(0.042),
  TICK_MS: num(10_000),
  DATA_REFRESH_MS: num(60_000),

  OKX_SITE: z.literal("eea").optional().default("eea"),
  OKX_API_BASE: str("https://eea.okx.com"),
  OKX_CLI_TIMEOUT_MS: num(15_000),

  BEE_START_EQUITY_USD: num(333),
  MAX_LEVERAGE: num(2),
  MARGIN_MODE: z.literal("isolated").optional().default("isolated"),
  MAX_NOTIONAL_USD_PER_BEE: num(700),
  DAILY_LOSS_STOP_PCT: num(8),
  BEE_RETIRE_AT_PCT: num(40),
  MAX_FLAT_MINUTES: num(30),
  LIVE_SIZE_MULTIPLIER: num(0.25),
  LIVE_RAMP_HOURS: num(2),
  MIN_24H_VOL_USD: num(1_000_000),
  ALLOW_NON_CRYPTO: bool(false),
  TAKER_FEE_RATE: num(0.0005),

  BREEZY_MIN_OPEN_PROB: num(0.7),
  BREEZY_MIN_SIZE_USD: num(10),
  BIZZY_SIZE_FRACTION: num(0.4),
  BIZZY_UNIVERSE_SIZE: num(8),
  BIZZY_TIME_STOP_MINUTES: num(240),
  BOOZY_CANDIDATES: num(5),
  // Fork: Hawk (bee4) has no trade cap, fee budget or cooldown. Its only
  // spending limit is the shared JEV_DAILY_USD_CAP. Hawk's prompt is the whole universe, so its Jev call gets longer than the menu bees' JEV_TIMEOUT_MS.
  HAWK_JEV_TIMEOUT_MS: num(20_000),
  HAWK_MAX_OUTPUT_TOKENS: num(4000),
  // Defaults = the "wider swings" rules in strategies/*.md (what the original bees ran from 2026-09-24).
  ...perStyle("BREEZY", { trades: 3, fee: 1.0, spread: 5, cooldown: 240, stopAtr: 2, maxFlat: 0 }),
  ...perStyle("BIZZY", { trades: 1, fee: 1.0, spread: 5, cooldown: 5, stopAtr: 1.5, maxFlat: 20 }),
  ...perStyle("BOOZY", { trades: 3, fee: 3.0, spread: 15, cooldown: 2, stopAtr: 2, maxFlat: 0 }),
  ...perSlot("BEE1"),
  ...perSlot("BEE2"),
  ...perSlot("BEE3"),
  // Real money needs DRY_RUN=false, MODE=live AND this set to LIVE_ACK_PHRASE. Paper trading needs none of it.
  LIVE_ACK: opt,

  ENGINE_PORT: num(8080),
  ENGINE_BIND: str("127.0.0.1"),
  // "{mode}" is replaced with dry/demo/live, so each mode keeps its own books.
  DB_PATH: str("./data/bees-{mode}.sqlite"),
  // Written by the Setup page. Anything set in the environment wins over it.
  SETTINGS_PATH: str("./data/settings.json"),
  OPENAI_API_KEY: opt,
  OPENAI_TEXT_MODEL: str("gpt-5.4-nano"),
  OPENAI_IMAGE_MODEL: str("gpt-image-2"),
  // Optional links shown on the dashboard (the "Hosted on Hostinger" chip and the "Get the code" link).
  HOST_LINK: str("https://mrc.fm/beebots"),
  REPO_LINK: str("https://github.com/imikerussell/beebots"),
  // The Hive: the public leaderboard that installs can join (paper only). Reports go to <HIVE_URL>/hive/report.
  HIVE_URL: str("https://beebots.tech"),
  // "Update available" on the dashboard: checks this repo's latest GitHub Release against APP_VERSION (set by the build).
  UPDATE_CHECK: bool(true),
  UPDATE_REPO: str("imikerussell/beebots"),
  APP_VERSION: str("dev"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  ALERT_WEBHOOK_URL: opt,
});

export interface BeeKnobs {
  maxTradesPerDay: number;
  feeBudgetUsdDay: number;
  spreadGateBps: number;
  cooldownMinutes: number;
  stopAtrMult: number;
  /** Effective max flat minutes: min(per-bee, global MAX_FLAT_MINUTES). 0 means "never flat past one tick". */
  maxFlatMinutes: number;
}

export interface OkxCreds {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** A bee as the dashboard shows it. No secrets. */
export interface SlotProfile {
  style: SlotStyle;
  name: string;
  tagline: string;
  /** A portrait generated on Setup lives in the data volume. */
  customImage: boolean;
  /** The owner's rules (fed to Jev) and coin restriction, from Setup. Empty for the original three. */
  rules: string;
  coins: string[];
  /** Made on the Setup page (never shown with the original bees' art). */
  fromSetup: boolean;
}

export interface Config {
  mode: Mode;
  slots: Record<BeeId, SlotProfile>;
  openai: { apiKey?: string; textModel: string; imageModel: string };
  links: { sponsor: string; code: string };
  hive: { url: string };
  update: { enabled: boolean; repo: string; version: string };
  settingsPath: string;
  jev: { provider: "typesafe" | "openrouter"; apiKey: string; model: string; baseUrl?: string; rawApiKey?: string; rawModel?: string; localUrl?: string; localModel?: string; localTimeoutMs?: number; timeoutMs: number; dailyUsdCap: number; usdPerMTok: number };
  tickMs: number;
  dataRefreshMs: number;
  okx: { site: "eea"; apiBase: string; cliTimeoutMs: number };
  risk: {
    startEquityUsd: number;
    maxLeverage: number;
    maxNotionalUsdPerBee: number;
    dailyLossStopPct: number;
    retireAtPct: number;
    maxFlatMinutes: number;
    liveSizeMultiplier: number;
    liveRampHours: number;
    takerFeeRate: number;
  };
  universe: { min24hVolUsd: number; allowNonCrypto: boolean };
  /** Knobs per trading style. hawk: none of them apply (0 = no trade cap and no fee budget; see src/hawk.ts). */
  bees: Record<SlotStyle, BeeKnobs>;
  hawk: { timeoutMs: number; maxOutputTokens: number; everyMs: number };
  control: { enabled: boolean; localEveryMs: number };
  breezy: { minOpenProb: number; minSizeUsd: number };
  bizzy: { sizeFraction: number; universeSize: number; timeStopMinutes: number };
  boozy: { candidates: number };
  /** Per-bee OKX credentials for the current mode. Never logged, never sent to the dashboard. */
  creds: Partial<Record<BeeId, OkxCreds>>;
  server: { port: number; bind: string };
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertWebhookUrl?: string;
}

export class ConfigError extends Error {}

/** Fork: first line of a mounted secret file, or undefined if it is missing/empty. Never logged. */
function readKeyFile(path: string): string | undefined {
  try {
    const k = readFileSync(path, "utf8").split(/\r?\n/)[0]?.trim();
    return k ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Parse and validate the environment (plus the Setup file, if any). Throws ConfigError listing NAMES only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: Settings | null = null): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid settings:\n  ${names.join("\n  ")}`);
  }
  const e = parsed.data as Record<string, unknown> & z.infer<typeof EnvSchema>;
  const mode: Mode = e.DRY_RUN ? "dry" : e.MODE;

  const jevKey = e.JEV_API_KEY_FILE ? readKeyFile(e.JEV_API_KEY_FILE) : (e.TYPESAFE_API_KEY ?? settings?.jevKey);
  const missing: string[] = [];
  if (!jevKey) missing.push(e.JEV_PROVIDER === "openrouter" ? "JEV_API_KEY_FILE" : "TYPESAFE_API_KEY");
  if (mode === "live" && e.LIVE_ACK !== LIVE_ACK_PHRASE) {
    throw new ConfigError(`MODE=live moves real money. Set LIVE_ACK=${LIVE_ACK_PHRASE} to confirm you accept the risk, or go back to DRY_RUN=true.`);
  }

  if (e.MAX_LEVERAGE > 2 || e.MAX_LEVERAGE <= 0) throw new ConfigError("MAX_LEVERAGE must be in (0, 2]. Hard rule 3.");
  if (e.MAX_FLAT_MINUTES < 0) throw new ConfigError("MAX_FLAT_MINUTES must be >= 0");

  const slots = {} as Record<BeeId, SlotProfile>;
  BEES.forEach((id, i) => {
    const b = DEFAULT_SLOTS[id] === "hawk" ? undefined : settings?.bees[i];
    const style: SlotStyle = b?.style ?? DEFAULT_SLOTS[id];
    slots[id] = b
      ? { style, name: b.name, tagline: b.tagline, customImage: b.image, rules: b.rules, coins: b.coins, fromSetup: true }
      : { style, name: SLOT_STYLE_INFO[style].name, tagline: SLOT_STYLE_INFO[style].tagline, customImage: false, rules: "", coins: [], fromSetup: false };
  });

  const creds: Partial<Record<BeeId, OkxCreds>> = {};
  if (mode !== "dry") {
    const infix = mode === "demo" ? "OKX_DEMO_API" : "OKX_API";
    // Hawk is paper only: it never gets exchange keys and never trades outside MODE=dry (engine.ts).
    for (const bee of BEES.filter((b) => slots[b].style !== "hawk")) {
      const p = bee.toUpperCase();
      const k = e[`${p}_${infix}_KEY`] as string | undefined;
      const s = e[`${p}_${infix}_SECRET`] as string | undefined;
      const ph = e[`${p}_${infix}_PASSPHRASE`] as string | undefined;
      if (!k) missing.push(`${p}_${infix}_KEY`);
      if (!s) missing.push(`${p}_${infix}_SECRET`);
      if (!ph) missing.push(`${p}_${infix}_PASSPHRASE`);
      if (k && s && ph) creds[bee] = { apiKey: k, secretKey: s, passphrase: ph };
    }
  }
  if (missing.length) {
    throw new ConfigError(`MODE=${mode} needs these settings, which are blank or missing:\n  ${missing.join("\n  ")}`);
  }

  const hawkKnobs: BeeKnobs = {
    maxTradesPerDay: 0,
    feeBudgetUsdDay: 0,
    spreadGateBps: Number.POSITIVE_INFINITY,
    cooldownMinutes: 0,
    stopAtrMult: 0,
    maxFlatMinutes: 0,
  };
  const knobs = (style: StyleId): BeeKnobs => {
    const p = style.toUpperCase();
    const n = (k: string) => e[`${p}_${k}`] as number;
    return {
      maxTradesPerDay: n("MAX_TRADES_PER_DAY"),
      feeBudgetUsdDay: n("FEE_BUDGET_USD_DAY"),
      spreadGateBps: n("SPREAD_GATE_BPS"),
      cooldownMinutes: n("COOLDOWN_MINUTES"),
      stopAtrMult: n("STOP_ATR_MULT"),
      maxFlatMinutes: Math.min(n("MAX_FLAT_MINUTES"), e.MAX_FLAT_MINUTES),
    };
  };

  return {
    mode,
    slots,
    openai: { apiKey: e.OPENAI_API_KEY ?? settings?.openaiKey, textModel: e.OPENAI_TEXT_MODEL, imageModel: e.OPENAI_IMAGE_MODEL },
    links: { sponsor: e.HOST_LINK, code: e.REPO_LINK },
    hive: { url: e.HIVE_URL.replace(/\/+$/, "") },
    update: { enabled: e.UPDATE_CHECK, repo: e.UPDATE_REPO, version: e.APP_VERSION },
    settingsPath: e.SETTINGS_PATH,
    jev: {
      provider: e.JEV_PROVIDER,
      baseUrl: e.JEV_BASE_URL,
      rawApiKey: e.HAWK_OPENROUTER_KEY_FILE ? readKeyFile(e.HAWK_OPENROUTER_KEY_FILE) : undefined,
      rawModel: e.HAWK_OPENROUTER_KEY_FILE ? e.HAWK_MODEL : undefined,
      localUrl: e.JEV_LOCAL_URL,
      localModel: e.JEV_LOCAL_MODEL,
      localTimeoutMs: e.JEV_LOCAL_TIMEOUT_MS,
      apiKey: jevKey!,
      model: e.JEV_MODEL,
      timeoutMs: e.JEV_TIMEOUT_MS,
      dailyUsdCap: e.JEV_DAILY_USD_CAP,
      usdPerMTok: e.JEV_USD_PER_MTOK,
    },
    tickMs: Math.max(1000, e.TICK_MS),
    dataRefreshMs: Math.max(15_000, e.DATA_REFRESH_MS),
    okx: { site: e.OKX_SITE, apiBase: e.OKX_API_BASE.replace(/\/+$/, ""), cliTimeoutMs: e.OKX_CLI_TIMEOUT_MS },
    risk: {
      startEquityUsd: e.BEE_START_EQUITY_USD,
      maxLeverage: e.MAX_LEVERAGE,
      maxNotionalUsdPerBee: e.MAX_NOTIONAL_USD_PER_BEE,
      dailyLossStopPct: e.DAILY_LOSS_STOP_PCT,
      retireAtPct: e.BEE_RETIRE_AT_PCT,
      maxFlatMinutes: e.MAX_FLAT_MINUTES,
      liveSizeMultiplier: e.LIVE_SIZE_MULTIPLIER,
      liveRampHours: e.LIVE_RAMP_HOURS,
      takerFeeRate: e.TAKER_FEE_RATE,
    },
    universe: { min24hVolUsd: e.MIN_24H_VOL_USD, allowNonCrypto: e.ALLOW_NON_CRYPTO },
    bees: { bizzy: knobs("bizzy"), breezy: knobs("breezy"), boozy: knobs("boozy"), hawk: hawkKnobs },
    hawk: { timeoutMs: Math.max(1000, e.HAWK_JEV_TIMEOUT_MS), maxOutputTokens: Math.max(256, e.HAWK_MAX_OUTPUT_TOKENS), everyMs: Math.max(0, e.HAWK_EVERY_MS) },
    control: { enabled: e.CONTROL_MODE, localEveryMs: Math.max(0, e.CONTROL_LOCAL_EVERY_MS) },
    breezy: { minOpenProb: e.BREEZY_MIN_OPEN_PROB, minSizeUsd: e.BREEZY_MIN_SIZE_USD },
    bizzy: { sizeFraction: e.BIZZY_SIZE_FRACTION, universeSize: e.BIZZY_UNIVERSE_SIZE, timeStopMinutes: e.BIZZY_TIME_STOP_MINUTES },
    boozy: { candidates: e.BOOZY_CANDIDATES },
    creds,
    server: { port: e.ENGINE_PORT, bind: e.ENGINE_BIND },
    dbPath: e.DB_PATH.replaceAll("{mode}", mode),
    logLevel: e.LOG_LEVEL,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
  };
}
