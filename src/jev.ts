// Jev (TypeSafe AI) client: 2 s timeout, exponential backoff on 429/529, daily USD cap, cost accounting.
// Fail-closed: any failure returns { ok: false } and the risk layer holds.

import { createRequire } from "node:module";
import type * as SDK from "@typesafe-ai/sdk" with { "resolution-mode": "require" };
import type { Menu } from "./bees/types.js";
import { safeError } from "./redact.js";

// @typesafe-ai/sdk 0.6.0 ships only the CJS build (its ESM export path is missing), so load it via require.
const require = createRequire(import.meta.url);
const { TypeSafeClient, choice, score } = require("@typesafe-ai/sdk") as typeof SDK;

export interface JevAsk {
  strategy: string;
  state: Record<string, unknown>;
  menu: Menu;
  convictionLabels: readonly string[];
}

export interface JevAnswer {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Rounded expected conviction level, 0..3. */
  conviction: number;
  convictionRaw: number;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface JevFailure {
  ok: false;
  reason: "daily_cap" | "backoff" | "error";
  error?: { code: string; message: string };
  latencyMs: number;
}

export type JevResult = JevAnswer | JevFailure;

/** Fork: the yes/no answers of one "Jev in control" call. */
export type NoulResult =
  | { ok: true; answers: Record<string, number>; costUsd: number; latencyMs: number; inputTokens: number; model: string; source: "native" | "local" }
  | JevFailure;

/** Anything with the SDK's systemOne shape, so tests can inject a fake. */
export interface SystemOne {
  systemOne(req: SDK.SystemOneRequest, opts?: SDK.RequestOptions): PromiseLike<SDK.SystemOneResult<SDK.Questions>>;
}

export interface JevOpts {
  /** Fork: "openrouter" = typesafe/jev-router over OpenRouter's chat API; cost comes from usage.cost. */
  provider?: "typesafe" | "openrouter";
  apiKey: string;
  model: string;
  timeoutMs: number;
  dailyUsdCap: number;
  usdPerMTok: number;
  /** Spend already recorded today (restored from the DB on restart). */
  spentTodayUsd?: number;
  client?: SystemOne;
  now?: () => number;
  /** Fork: injectable fetch for Hawk's free-form call (tests). */
  fetchImpl?: typeof fetch;
  /** Fork: TypeSafe-compatible base URL, e.g. Vercel AI Gateway https://ai-gateway.vercel.sh/typesafe. */
  baseUrl?: string;
  /** Fork: Hawk's free-form call always goes to OpenRouter (native Jev only answers typed questions).
   *  When set, these are used instead of apiKey/model, so the menu bots can run on native Jev at the same time. */
  rawApiKey?: string;
  rawModel?: string;
  /** Fork: when native Jev is busy, the menu bees ask a
   *  local Ollama model (e.g. Ollama on another machine) instead of holding. Free; ~2 s warm. */
  localUrl?: string;
  localModel?: string;
  localTimeoutMs?: number;
}

/** Fork: Hawk's free-form call. The raw reply is parsed by hawk.ts (fail-closed). */
export interface JevRawAnswer {
  ok: true;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Jev {
  private client: SystemOne;
  private now: () => number;
  private day: string;
  spentTodayUsd: number;
  private backoffUntil = 0;
  private backoffStep = 0;
  /** Fork: native Jev (Vercel) answers 429 "high demand" at times. While it is backed off, the menu bees fall
   *  back to OpenRouter's typesafe/jev-router (rawApiKey/rawModel) instead of holding. */
  private nativeBackoffUntil = 0;
  private nativeBackoffStep = 0;
  /** First failure of the current outage, for the "Jev down > 5 min" alert. */
  downSince: number | null = null;

  constructor(private opts: JevOpts) {
    this.client =
      opts.client ??
      new TypeSafeClient({
        apiKey: opts.apiKey,
        defaultModel: opts.model,
        timeout: opts.timeoutMs,
        retry: { maxRetries: 0 }, // we back off ourselves; a 2 s tick must not wait on SDK retries
        logLevel: "off", // SDK debug logging would print request bodies
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      } as ConstructorParameters<typeof TypeSafeClient>[0]);
    this.now = opts.now ?? Date.now;
    this.day = dayKey(this.now());
    this.spentTodayUsd = opts.spentTodayUsd ?? 0;
  }

  get capTripped(): boolean {
    this.rollDay();
    return this.spentTodayUsd >= this.opts.dailyUsdCap;
  }

  private rollDay() {
    const d = dayKey(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spentTodayUsd = 0;
    }
  }

  async decide(ask: JevAsk): Promise<JevResult> {
    const t0 = this.now();
    if (this.capTripped) return { ok: false, reason: "daily_cap", latencyMs: 0 };
    if (t0 < this.backoffUntil) return { ok: false, reason: "backoff", latencyMs: 0 };

    const labels = Object.keys(ask.menu);
    if (labels.length === 0) return { ok: false, reason: "error", error: { code: "EMPTY_MENU", message: "no valid options" }, latencyMs: 0 };
    const criteria = Object.fromEntries(labels.map((l) => [l, ask.menu[l]!.desc]));
    const conv = ask.convictionLabels as unknown as readonly [string, string, ...string[]];

    if (this.opts.provider === "openrouter" && !this.opts.client) return this.decideOpenRouter(ask, labels, criteria, conv, t0);
    const canFallback = !!this.opts.localUrl;
    if (canFallback && t0 < this.nativeBackoffUntil) return this.decideLocal(ask, labels, criteria, conv, t0);

    try {
      const r = await this.client.systemOne(
        {
          model: this.opts.model,
          state: ask.state as SDK.EntryType,
          questions: {
            action: choice(`${ask.strategy} Pick your next move.`, criteria),
            conviction: score("Signal strength?", conv),
          },
        },
        { timeout: this.opts.timeoutMs, retry: { maxRetries: 0 } },
      );
      const latencyMs = this.now() - t0;
      const a = r.answers.action as SDK.ChoiceResponse;
      const c = r.answers.conviction as SDK.ScoreResponse;
      const inputTokens = r.usage?.input_tokens ?? 0;
      const costUsd = (inputTokens * this.opts.usdPerMTok) / 1e6;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.backoffStep = 0;
      this.nativeBackoffStep = 0;
      this.downSince = null;
      if (!labels.includes(a.choice)) {
        return { ok: false, reason: "error", error: { code: "OFF_MENU", message: `choice not in menu` }, latencyMs };
      }
      return {
        ok: true,
        choice: a.choice,
        probabilities: { ...a.probabilities },
        confidence: a.confidence,
        conviction: Math.max(0, Math.min(conv.length - 1, Math.round(c.score))),
        convictionRaw: c.score,
        inputTokens,
        costUsd,
        latencyMs,
        model: r.model,
      };
    } catch (err) {
      const latencyMs = this.now() - t0;
      const status = (err as { status?: number }).status;
      const busy = status === 429 || status === 529 || (status !== undefined && status >= 500);
      if (busy && canFallback) {
        this.nativeBackoffStep = Math.min(this.nativeBackoffStep + 1, 8);
        this.nativeBackoffUntil = this.now() + Math.min(300_000, 1000 * 2 ** this.nativeBackoffStep);
        return this.decideLocal(ask, labels, criteria, conv, t0);
      }
      if (busy) {
        this.backoffStep = Math.min(this.backoffStep + 1, 6);
        this.backoffUntil = this.now() + Math.min(60_000, 1000 * 2 ** this.backoffStep);
      }
      this.downSince ??= t0;
      return { ok: false, reason: "error", error: safeError(err), latencyMs };
    }
  }

  /** Fork: the fallback decision on a local Ollama model. Same strict-JSON menu contract as the OpenRouter path;
   *  costs $0. Any failure (local model host down, bad JSON, off-menu) holds, and never trips the global backoff. */
  private async decideLocal(
    ask: JevAsk,
    labels: string[],
    criteria: Record<string, string | null | undefined>,
    conv: readonly string[],
    t0: number,
  ): Promise<JevResult> {
    const body = {
      model: this.opts.localModel ?? "qwen3.6:35b-a3b",
      stream: false,
      think: false,
      format: "json",
      keep_alive: "30m",
      options: { temperature: 0 },
      messages: [
        {
          role: "system",
          content:
            "You are a trading decision engine. Reply with ONLY a JSON object of the form " +
            '{"action":{"choice":"<one option label>","probabilities":{"<label>":<0..1>,...}},"conviction":<integer index into conviction_levels>}. ' +
            "Give a probability for EVERY option label; they must sum to 1. Never choose a label that is not in options.",
        },
        { role: "user", content: JSON.stringify({ strategy: `${ask.strategy} Pick your next move.`, state: ask.state, options: criteria, conviction_levels: conv }) },
      ],
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.localTimeoutMs ?? 15_000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.localUrl!.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const latencyMs = this.now() - t0;
      if (!res.ok) return { ok: false, reason: "error", error: { code: "LOCAL_HTTP", message: `local model HTTP ${res.status}` }, latencyMs };
      const j = (await res.json()) as { model?: string; prompt_eval_count?: number; message?: { content?: string } };
      const raw = j.message?.content ?? "";
      let parsed: { action?: { choice?: unknown; probabilities?: Record<string, unknown> }; conviction?: unknown };
      try {
        parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      } catch {
        return { ok: false, reason: "error", error: { code: "BAD_JSON", message: "local reply was not JSON" }, latencyMs };
      }
      const pick = parsed.action?.choice;
      if (typeof pick !== "string" || !labels.includes(pick)) {
        return { ok: false, reason: "error", error: { code: "OFF_MENU", message: "local choice not in menu" }, latencyMs };
      }
      const probabilities: Record<string, number> = {};
      for (const l of labels) {
        const v = Number(parsed.action?.probabilities?.[l]);
        probabilities[l] = Number.isFinite(v) && v >= 0 ? v : 0;
      }
      const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
      if (sum > 0) for (const l of labels) probabilities[l] = probabilities[l]! / sum;
      else probabilities[pick] = 1;
      const convRaw = Number(parsed.conviction);
      const convictionRaw = Number.isFinite(convRaw) ? convRaw : 0;
      return {
        ok: true,
        choice: pick,
        probabilities,
        confidence: probabilities[pick] ?? 0,
        conviction: Math.max(0, Math.min(conv.length - 1, Math.round(convictionRaw))),
        convictionRaw,
        inputTokens: j.prompt_eval_count ?? 0,
        costUsd: 0,
        latencyMs,
        model: `local:${j.model ?? body.model}`,
      };
    } catch (err) {
      return { ok: false, reason: "error", error: safeError(err), latencyMs: this.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fork: the same decision over OpenRouter. The router has no native choice/score API, so the menu and the
   *  conviction scale go in the prompt and the reply must be strict JSON; anything off-menu or unparseable fails closed. */
  private async decideOpenRouter(
    ask: JevAsk,
    labels: string[],
    criteria: Record<string, string | null | undefined>,
    conv: readonly string[],
    t0: number,
    fallback = false,
  ): Promise<JevResult> {
    const body = {
      model: fallback ? (this.opts.rawModel ?? this.opts.model) : this.opts.model,
      usage: { include: true },
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a trading decision engine. Reply with ONLY a JSON object of the form " +
            '{"action":{"choice":"<one option label>","probabilities":{"<label>":<0..1>,...}},"conviction":<integer index into conviction_levels>}. ' +
            "Give a probability for EVERY option label; they must sum to 1. Never choose a label that is not in options.",
        },
        {
          role: "user",
          content: JSON.stringify({
            strategy: `${ask.strategy} Pick your next move.`,
            state: ask.state,
            options: criteria,
            conviction_levels: conv,
          }),
        },
      ],
    };
    const ctl = new AbortController();
    // Fork: OpenRouter answers in 1.5-4 s, native Jev in ~0.7 s, so the fallback gets its own, longer timeout.
    const timer = setTimeout(() => ctl.abort(), fallback ? Math.max(this.opts.timeoutMs, 10_000) : this.opts.timeoutMs);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${fallback ? (this.opts.rawApiKey ?? this.opts.apiKey) : this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const latencyMs = this.now() - t0;
      if (!res.ok) {
        const err = Object.assign(new Error(`OpenRouter HTTP ${res.status}`), { status: res.status });
        throw err;
      }
      const j = (await res.json()) as {
        model?: string;
        usage?: { prompt_tokens?: number; cost?: number };
        choices?: { message?: { content?: string } }[];
      };
      const costUsd = Number(j.usage?.cost ?? 0) || 0;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.backoffStep = 0;
      this.downSince = null;
      const raw = j.choices?.[0]?.message?.content ?? "";
      let parsed: { action?: { choice?: unknown; probabilities?: Record<string, unknown> }; conviction?: unknown };
      try {
        parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      } catch {
        return { ok: false, reason: "error", error: { code: "BAD_JSON", message: "reply was not JSON" }, latencyMs };
      }
      const pick = parsed.action?.choice;
      if (typeof pick !== "string" || !labels.includes(pick)) {
        return { ok: false, reason: "error", error: { code: "OFF_MENU", message: "choice not in menu" }, latencyMs };
      }
      const probabilities: Record<string, number> = {};
      for (const l of labels) {
        const v = Number(parsed.action?.probabilities?.[l]);
        probabilities[l] = Number.isFinite(v) && v >= 0 ? v : 0;
      }
      const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
      if (sum > 0) for (const l of labels) probabilities[l] = probabilities[l]! / sum;
      else probabilities[pick] = 1;
      const convRaw = Number(parsed.conviction);
      const convictionRaw = Number.isFinite(convRaw) ? convRaw : 0;
      return {
        ok: true,
        choice: pick,
        probabilities,
        confidence: probabilities[pick] ?? 0,
        conviction: Math.max(0, Math.min(conv.length - 1, Math.round(convictionRaw))),
        convictionRaw,
        inputTokens: j.usage?.prompt_tokens ?? 0,
        costUsd,
        latencyMs,
        model: j.model ?? this.opts.model,
      };
    } catch (err) {
      const latencyMs = this.now() - t0;
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 529 || (status !== undefined && status >= 500)) {
        this.backoffStep = Math.min(this.backoffStep + 1, 6);
        this.backoffUntil = this.now() + Math.min(60_000, 1000 * 2 ** this.backoffStep);
      }
      this.downSince ??= t0;
      return { ok: false, reason: "error", error: safeError(err), latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fork: Hawk's call. Same key, same daily cap and cost accounting, same backoff, but a free-form prompt
   * (system + user) and the raw JSON text back. OpenRouter only. Any failure returns { ok: false } and Hawk holds.
   */
  async askRaw(system: string, user: string, o: { timeoutMs: number; maxOutputTokens: number }): Promise<JevRawAnswer | JevFailure> {
    const t0 = this.now();
    if (this.capTripped) return { ok: false, reason: "daily_cap", latencyMs: 0 };
    if (t0 < this.backoffUntil) return { ok: false, reason: "backoff", latencyMs: 0 };
    if (this.opts.provider !== "openrouter" && !this.opts.rawApiKey) return { ok: false, reason: "error", error: { code: "HAWK_NEEDS_OPENROUTER", message: "Hawk needs an OpenRouter key (HAWK_OPENROUTER_KEY_FILE)" }, latencyMs: 0 };
    const body = {
      model: this.opts.rawModel ?? this.opts.model,
      usage: { include: true },
      temperature: 0,
      max_tokens: o.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.rawApiKey ?? this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw Object.assign(new Error(`OpenRouter HTTP ${res.status}`), { status: res.status });
      const j = (await res.json()) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        choices?: { message?: { content?: string } }[];
      };
      const latencyMs = this.now() - t0;
      const costUsd = Number(j.usage?.cost ?? 0) || 0;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.backoffStep = 0;
      this.downSince = null;
      return {
        ok: true,
        raw: j.choices?.[0]?.message?.content ?? "",
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
        costUsd,
        latencyMs,
        model: j.model ?? this.opts.model,
      };
    } catch (err) {
      const latencyMs = this.now() - t0;
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 529 || (status !== undefined && status >= 500)) {
        this.backoffStep = Math.min(this.backoffStep + 1, 6);
        this.backoffUntil = this.now() + Math.min(60_000, 1000 * 2 ** this.backoffStep);
      }
      this.downSince ??= t0;
      const e = ctl.signal.aborted ? { code: "TIMEOUT", message: `no answer in ${o.timeoutMs} ms` } : safeError(err);
      return { ok: false, reason: "error", error: e, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fork: "Jev in control" (src/control.ts). One call, every question a yes/no (`noul`); returns the probability
   *  of YES per question id. Native Jev first; when it is busy (429/5xx) the local model answers, but only when the caller
   *  allows it (the engine throttles the slow local path). Fails closed. */
  async askNoul(state: Record<string, unknown>, questions: Record<string, string>, allowLocal: boolean): Promise<NoulResult> {
    const t0 = this.now();
    if (this.capTripped) return { ok: false, reason: "daily_cap", latencyMs: 0 };
    if (Object.keys(questions).length === 0) return { ok: false, reason: "error", error: { code: "NO_QUESTIONS", message: "nothing to ask" }, latencyMs: 0 };
    const local = async (): Promise<NoulResult> => {
      if (!this.opts.localUrl || !allowLocal) return { ok: false, reason: "backoff", latencyMs: this.now() - t0 };
      return this.noulLocal(state, questions, t0);
    };
    if (t0 < this.nativeBackoffUntil) return local();
    try {
      const qs = Object.fromEntries(Object.entries(questions).map(([k, v]) => [k, { type: "noul", instructions: v }])) as unknown as SDK.Questions;
      const r = await this.client.systemOne({ model: this.opts.model, state: state as SDK.EntryType, questions: qs }, { timeout: this.opts.timeoutMs, retry: { maxRetries: 0 } });
      const latencyMs = this.now() - t0;
      const inputTokens = r.usage?.input_tokens ?? 0;
      const costUsd = (inputTokens * this.opts.usdPerMTok) / 1e6;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.nativeBackoffStep = 0;
      this.downSince = null;
      const answers: Record<string, number> = {};
      for (const k of Object.keys(questions)) {
        const a = (r.answers as Record<string, { noul?: unknown }>)[k];
        const v = Number(a?.noul);
        if (Number.isFinite(v)) answers[k] = v;
      }
      return { ok: true, answers, costUsd, latencyMs, inputTokens, model: r.model, source: "native" };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const busy = status === 429 || status === 529 || (status !== undefined && status >= 500);
      if (busy) {
        this.nativeBackoffStep = Math.min(this.nativeBackoffStep + 1, 6);
        this.nativeBackoffUntil = this.now() + Math.min(60_000, 1000 * 2 ** this.nativeBackoffStep);
        return local();
      }
      this.downSince ??= t0;
      return { ok: false, reason: "error", error: safeError(err), latencyMs: this.now() - t0 };
    }
  }

  private async noulLocal(state: Record<string, unknown>, questions: Record<string, string>, t0: number): Promise<NoulResult> {
    const body = {
      model: this.opts.localModel ?? "qwen3.6:35b-a3b",
      stream: false,
      think: false,
      format: "json",
      keep_alive: "30m",
      options: { temperature: 0 },
      messages: [
        {
          role: "system",
          content:
            "You are a trading decision engine. Answer each yes/no question with the probability that the answer is YES (0..1). " +
            'Reply with ONLY a JSON object mapping each question id to its probability, e.g. {"buy_BTC": 0.62}.',
        },
        { role: "user", content: JSON.stringify({ state, questions }) },
      ],
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.localTimeoutMs ?? 15_000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.localUrl!.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const latencyMs = this.now() - t0;
      if (!res.ok) return { ok: false, reason: "error", error: { code: "LOCAL_HTTP", message: `local model HTTP ${res.status}` }, latencyMs };
      const j = (await res.json()) as { model?: string; prompt_eval_count?: number; message?: { content?: string } };
      const raw = j.message?.content ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "error", error: { code: "BAD_JSON", message: "local reply was not JSON" }, latencyMs };
      }
      const answers: Record<string, number> = {};
      for (const k of Object.keys(questions)) {
        const v = Number(parsed[k]);
        if (Number.isFinite(v)) answers[k] = v;
      }
      return { ok: true, answers, costUsd: 0, latencyMs, inputTokens: j.prompt_eval_count ?? 0, model: `local:${j.model ?? body.model}`, source: "local" };
    } catch (err) {
      return { ok: false, reason: "error", error: safeError(err), latencyMs: this.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Setup page: one tiny real call proves the key works. Returns an error message, or null when the key is good. */
export async function checkJevKey(apiKey: string, model: string, timeoutMs = 10_000): Promise<string | null> {
  const client = new TypeSafeClient({ apiKey, defaultModel: model, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: "off" });
  try {
    await client.systemOne(
      { model, state: { check: "setup" }, questions: { ok: choice("Is this a connection test?", { YES: null, NO: null }) } },
      { timeout: timeoutMs, retry: { maxRetries: 0 } },
    );
    return null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return "Jev rejected that key. Copy it again from console.typesafe.ai/keys.";
    const e = safeError(err);
    return `Could not reach Jev (${e.code}: ${e.message})`;
  }
}
