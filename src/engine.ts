import { customBrain } from "./bees/custom.js";
import { BRAINS } from "./bees/index.js";
import { maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import { coinOf, longOnlyMenu, type Action, type BeeBrain, type BeeContext, type BeeState, type Side } from "./bees/types.js";
import { BEES, type BeeId, type Config } from "./config.js";
import type { Alerts } from "./alerts.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import type { Jev, JevResult } from "./jev.js";
import { applyFill, applyFunding, freshBee, mark, rollDay } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { applyRisk, type JevStatus, type Proposal } from "./risk.js";
import { buildSnapshot } from "./snapshot.js";
import { buyNotional, candidateInstIds, controlAsk, pickControl, recordMids, type MidHistory } from "./control.js";
import type { AlpacaPaper, LiveQuote } from "./exec/alpaca.js";
import { applyExitPlan, HAWK_SYSTEM_PROMPT, hawkExitHit, hawkReport, parseHawkReply, planHawk, type HawkAnswer } from "./hawk.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often a benched bee gets a live P&L row in the stream. */
const PULSE_MS = 4_000;
const EQUITY_SNAPSHOT_MS = 10_000;

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  /** Fork: Alpaca paper (live feed + fills) for the Jev-in-control bots, when its keys are mounted. */
  alpaca?: AlpacaPaper;
  now?: () => number;
  /** True once someone asked to end the experiment (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
}

/** Fork: Hawk's last Jev answer, in full, for the dashboard card. */
interface HawkLast {
  answer: HawkAnswer | null;
  error: string | null;
  ts: number;
  latencyMs: number | null;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
}

export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last = {} as Partial<Record<BeeId, LastDecision>>;
  private hawkLast = {} as Partial<Record<BeeId, HawkLast>>;
  /** Fork: Jev-in-control state. Recent mids per coin for the second-level changes, the local-fallback throttle,
   *  and Hawk's own cadence. */
  private midHist: MidHistory = new Map();
  private lastLocalAt: Partial<Record<BeeId, number>> = {};
  private lastHawkAt: Partial<Record<BeeId, number>> = {};
  private live = new Map<string, LiveQuote>();
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt: Partial<Record<BeeId, number>> = {};
  private lastChipUsd: Partial<Record<BeeId, number>> = {};
  startedAt: number;
  private experimentStartedAt = 0;
  /** Experiment closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeAnnounced = false;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    for (const id of BEES) {
      // A new slot (bee4 = Hawk on a database made by the first three) starts fresh; the others are restored.
      this.bees[id] = db.loadBee(id) ?? freshBee(id, cfg.risk.startEquityUsd, this.now());
      if (this.onExchange(id)) await this.d.exec.init(id);
      if (this.isHawk(id)) this.hawkLast[id] = this.restoreHawkLast(id);
    }

    await this.refreshMarket();
    if (this.d.exec.kind === "okx") await this.reconcile();

    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    this.d.alerts.send(`engine started (MODE=${cfg.mode})`);

    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => this.d.db.pruneEvents(this.now() - 3 * 86_400_000), 3_600_000));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const id of BEES) this.d.db.saveBee(this.bees[id], this.now());
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankBoozyHourly();
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      for (const id of BEES) this.markBee(id, now);
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (this.d.cfg.control.enabled) {
        const v = this.d.feed.view();
        if (this.d.alpaca) {
          // Live Alpaca quotes + books for every coin a control bot could buy or holds; the second-level changes come from these.
          const ids = new Set<string>();
          for (const b of BEES) {
            if (this.isHawk(b)) continue;
            for (const c of this.controlCandidates(b, v)) ids.add(c);
            const p = this.bees[b].position;
            if (p) ids.add(p.instId);
          }
          try {
            this.live = await this.d.alpaca.live([...ids]);
            for (const [id, q] of this.live) {
              const arr = this.midHist.get(id) ?? [];
              arr.push([now, q.mid]);
              while (arr.length && now - arr[0]![0] > 6 * 60_000) arr.shift();
              this.midHist.set(id, arr);
            }
          } catch (err) {
            this.live = new Map();
            log.warn("alpaca live data failed", { err: safeError(err) });
          }
        } else recordMids(this.midHist, v, v.stats.keys(), now);
      }
      if (this.d.exec.kind === "sim") this.simulateFunding(now);

      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else await Promise.all(BEES.map((id) => this.decide(id, now).catch((err) => log.error("decision failed", { bee: id, err: safeError(err) }))));

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        for (const id of BEES) {
          const b = this.bees[id];
          this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
        }
      }
      this.d.bus.emit("equity", { bees: BEES.map((id) => this.publicBee(id)) }, now);
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
    } finally {
      this.ticking = false;
    }
  }

  private ctx(id: BeeId, now: number): BeeContext {
    const bee = this.bees[id];
    const p = bee.position;
    return {
      bee,
      view: this.d.feed.view(),
      cfg: this.d.cfg,
      knobs: this.knobs(id),
      now,
      uplR: p && p.riskUsd > 0 ? bee.uplUsd / p.riskUsd : null,
    };
  }

  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const p = bee.position;
    const t = p ? view.tickers.get(p.instId) : undefined;
    mark(bee, t?.mid, p ? view.instruments.get(p.instId)?.ctVal : undefined);
    if (rollDay(bee, now)) {
      this.d.bus.emit("cap", { bee: id, cap: null, detail: "new UTC day: counters and caps reset" }, now);
    }
    // Trailing stop: only ever ratchets in the position's favour. (Hawk has no brain: its stop is Jev's own.)
    const brain = this.isHawk(id) ? null : this.brain(id);
    if (p && brain?.trail) {
      const cand = brain.trail(this.ctx(id, now));
      if (cand !== null && Number.isFinite(cand)) {
        if (p.stopPx === null) p.stopPx = cand;
        else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
      }
    }
  }

  private async decide(id: BeeId, now: number): Promise<void> {
    if (this.isHawk(id)) {
      // Hawk keeps its own cadence when the tick is fast (Jev in control runs the others every few seconds).
      if (now - (this.lastHawkAt[id] ?? 0) < this.d.cfg.hawk.everyMs) return;
      this.lastHawkAt[id] = now;
      return this.decideHawk(id, now);
    }
    if (this.d.cfg.control.enabled) return this.decideControl(id, now);
    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain(id);
    const bee = this.bees[id];
    // Benched (trade cap or fee budget): the bee rides whatever it holds. Jev is not asked, because nothing it
    // chose could be acted on; only code can close the position (stop, time stop, loss stop) until 00:00 UTC.
    if (bee.cap === "trade_cap" || bee.cap === "fee_budget") return this.decideBenched(id, now);
    const ctx = this.ctx(id, now);
    const menu = longOnlyMenu(brain.menu(ctx));
    const snap = buildSnapshot(brain, ctx);
    if (brain.id === "boozy" && bee.top1.coin) snap.state.top1 = `${bee.top1.coin} x${bee.top1.streak}`;

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    if (jev.capTripped) jevStatus = "daily_cap";
    else if (Object.keys(menu).length === 0) jevStatus = "no_options";
    else {
      r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
    }
    const proposal: Proposal | null =
      r && r.ok ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction } : null;

    const risk = applyRisk({
      ctx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });

    if (risk.capTripped) {
      const detail = risk.status;
      db.insertCap(id, now, risk.capTripped, detail);
      bus.emit("cap", { bee: id, cap: risk.capTripped, detail }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    bee.cap = risk.cap;

    // Hard rule 10: recorded before it is acted on.
    const costUsd = r && r.ok ? r.costUsd : 0;
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(Object.keys(menu)),
      choice: r && r.ok ? r.choice : null,
      probabilities: r && r.ok ? r.probabilities : null,
      confidence: r && r.ok ? r.confidence : null,
      conviction: r && r.ok ? r.convictionRaw : null,
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      action: risk.action,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status: risk.status,
    });
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;

    const top3 = r && r.ok ? (Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>) : [];
    this.last[id] = { choice: r && r.ok ? r.choice : null, top3, confidence: r && r.ok ? r.confidence : null, latencyMs: r ? r.latencyMs : null, status: risk.status, ts: now };
    // Flat and nothing to ask Jev (bizzy waiting for her breakout): a live "watching" row every PULSE_MS instead of a
    // "no call" row every tick, so the stream shows how close the trigger is.
    const watching = jevStatus === "no_options" && !bee.position && !!brain.idleStatus && risk.action.kind === "none";
    if (watching && now - (this.lastPulseAt[id] ?? 0) < PULSE_MS) {
      db.saveBee(bee, now);
      return;
    }
    if (watching) this.lastPulseAt[id] = now;
    bus.emit(
      "decision",
      {
        bee: id,
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : null,
        ...(watching ? { watch: risk.status } : {}),
        probabilities: top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        confidence: r && r.ok ? Number(r.confidence.toFixed(3)) : null,
        conviction: r && r.ok ? brain.convictionLabels[r.conviction] : null,
        latencyMs: r ? r.latencyMs : null,
        tokens: r && r.ok ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(risk.action),
        vetoedBy: risk.vetoedBy,
        forcedBy: risk.forcedBy,
        status: risk.status,
        jev: jevStatus,
        ...this.liveChip(id),
      },
      now,
    );

    if (risk.action.kind !== "none") await this.execute(id, risk.action, decisionId, ctx, proposal?.conviction ?? 0);
    db.saveBee(bee, now);
  }

  // ---------- Hawk (bee4): Jev with free rein (src/hawk.ts) ----------

  private async decideHawk(id: BeeId, now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const bee = this.bees[id];
    const view = this.d.feed.view();
    bee.cap = null; // Hawk has no caps: no trade cap, fee budget, loss stop or retirement.
    const setLast = (choice: string | null, status: string, latencyMs: number | null) => {
      this.last[id] = { choice, top3: [], confidence: null, latencyMs, status, ts: now };
    };
    // Hard limit: paper only. Outside MODE=dry Hawk does nothing at all.
    if (cfg.mode !== "dry") {
      setLast(null, "paper only: Hawk does not trade outside MODE=dry", null);
      return;
    }

    // 1. Jev's own exit plan, executed by code every tick (also while Jev is down or capped).
    const p = bee.position;
    if (p) {
      const hit = hawkExitHit(p, view.tickers.get(p.instId)?.mid);
      if (hit) {
        const status = `${hit === "take_profit" ? "take-profit" : "stop-loss"} hit on ${p.coin} (Jev's own exit plan)`;
        const action: Action = { kind: "close", reason: hit };
        const decisionId = db.insertDecision({
          bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
          conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null, action, vetoedBy: null, forcedBy: hit, status,
        });
        setLast(null, status, null);
        bus.emit("decision", {
          bee: id, choice: hit === "take_profit" ? "TAKE PROFIT" : "STOP LOSS", probabilities: [], confidence: null, conviction: null, latencyMs: null,
          tokens: null, jevUsd: 0, action: describeAction(action), vetoedBy: null, forcedBy: hit, status, jev: "no_options", ...this.liveChip(id),
        }, now);
        await this.order(id, decisionId, p.instId, "sell", p.contracts, true, hit);
        db.saveBee(bee, now);
        return;
      }
    }

    // 2. Ask Jev: the whole gated universe + Hawk's books, one complete decision back.
    const report = hawkReport({ bee, view, startEquityUsd: cfg.risk.startEquityUsd, takerFeeRate: cfg.risk.takerFeeRate, now, last: this.hawkLast[id]?.answer ?? null });
    const stateJson = JSON.stringify(report);
    const universe = view.gated.map(coinOf);
    const r = await jev.askRaw(HAWK_SYSTEM_PROMPT, stateJson, cfg.hawk);
    const parsed = r.ok ? parseHawkReply(r.raw, universe) : null;
    const answer = parsed?.ok ? parsed.answer : null;
    const jevStatus = !r.ok ? (r.reason === "daily_cap" ? "daily_cap" : "unreachable") : "ok";
    const jevError = !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : parsed && !parsed.ok ? `${parsed.code}: ${parsed.message}` : null;

    let plan: ReturnType<typeof planHawk>;
    if (answer) {
      plan = planHawk({ answer, bee, view, takerFeeRate: cfg.risk.takerFeeRate, dataStale: now - this.d.feed.lastRefreshAt > 3 * cfg.dataRefreshMs + 30_000 });
      if (parsed?.ok && parsed.clamped) plan.status = `${plan.status} (${parsed.clamped})`;
    } else {
      const why = !r.ok ? (r.reason === "daily_cap" ? "Jev daily cap hit: holding" : `Jev unreachable: holding (${r.error?.code ?? r.reason})`) : `bad answer from Jev, holding (${parsed && !parsed.ok ? parsed.code : "?"})`;
      plan = { action: { kind: "none" }, vetoedBy: !r.ok ? (r.reason === "daily_cap" ? "jev_daily_cap" : "jev_unreachable") : "invalid_answer", countsAsTrade: false, status: why };
    }
    const choice = answer ? `${answer.action}${answer.coin ? ` ${answer.coin}` : ""}${answer.size_pct !== null ? ` ${answer.size_pct}%` : ""}` : null;
    const costUsd = r.ok ? r.costUsd : 0;

    // Hard rule 10: recorded before it is acted on. Hawk has no menu, so menu_json holds Jev's full answer
    // (or the start of the raw reply when it could not be parsed).
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: null,
      stateJson,
      menuJson: JSON.stringify({ hawk: answer, ...(r.ok && !answer ? { raw: r.raw.slice(0, 600) } : {}), ...(r.ok ? { outputTokens: r.outputTokens, model: r.model } : {}) }),
      choice,
      probabilities: null,
      confidence: null,
      conviction: null,
      latencyMs: r.latencyMs,
      inputTokens: r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError,
      action: plan.action,
      vetoedBy: plan.vetoedBy,
      forcedBy: null,
      status: plan.status,
    });
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;
    this.hawkLast[id] = r.ok
      ? { answer, error: jevError, ts: now, latencyMs: r.latencyMs, costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens }
      : { answer: this.hawkLast[id]?.answer ?? null, error: jevError, ts: now, latencyMs: r.latencyMs, costUsd: 0, inputTokens: null, outputTokens: null };
    setLast(choice, plan.status, r.latencyMs);
    bus.emit(
      "decision",
      {
        bee: id,
        choice,
        probabilities: [],
        confidence: null,
        conviction: null,
        latencyMs: r.latencyMs,
        tokens: r.ok ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(plan.action),
        vetoedBy: plan.vetoedBy,
        forcedBy: null,
        status: plan.status,
        jev: jevStatus,
        hawk: answer,
        ...this.liveChip(id),
      },
      now,
    );

    // 3. Execute. The exit plan goes on the position from its (average) entry price.
    const ordersBefore = bee.totals.orders;
    if (plan.action.kind !== "none") await this.execute(id, plan.action, decisionId, this.ctx(id, now), 0);
    const filled = bee.totals.orders > ordersBefore;
    if (filled && plan.countsAsTrade) bee.tradesToday++;
    const held = bee.position;
    if (answer && held && answer.coin === held.coin && (answer.action === "BUY" || answer.action === "SWITCH") && (filled || plan.vetoedBy === "already_at_size")) {
      const inst = view.instruments.get(held.instId);
      if (inst) applyExitPlan(held, answer, inst.ctVal);
    }
    db.saveBee(bee, now);
  }

  /** The control bot's coins, limited to what Alpaca paper can trade when it is the venue. */
  private controlCandidates(id: BeeId, view: ReturnType<MarketFeed["view"]>): string[] {
    const all = candidateInstIds(this.d.cfg.slots[id].style as never, view);
    const a = this.d.alpaca;
    return a ? all.filter((i) => a.coins.has(coinOf(i))) : all;
  }

  /** Fork: Jev in control (src/control.ts). The state goes before Jev as yes/no questions; a yes IS the order.
   *  No trade caps, cooldowns, confidence gates, forced entries, loss stops or retirement.
   *  Code keeps only: paper, the bot's own cash, long-only spot, the stop-loss set at entry, the Jev cap, hold on errors. */
  private async decideControl(id: BeeId, now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const brain = this.brain(id);
    bee.cap = null;
    const p = bee.position;

    const record = (choice: string | null, answers: Record<string, number> | null, action: Action, status: string, extra: { latencyMs: number | null; costUsd: number; inputTokens: number | null; err: string | null; state: unknown; questions: unknown; forcedBy?: string | null; jevState: JevStatus }) => {
      const top3 = answers ? Object.entries(answers).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, Number(v.toFixed(2))] as [string, number]) : [];
      const top = top3[0]?.[1] ?? null;
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: null, stateJson: JSON.stringify(extra.state), menuJson: JSON.stringify({ control: extra.questions }),
        choice, probabilities: answers, confidence: top, conviction: null, latencyMs: extra.latencyMs, inputTokens: extra.inputTokens,
        jevCostUsd: extra.costUsd, jevError: extra.err, action, vetoedBy: null, forcedBy: extra.forcedBy ?? null, status,
      });
      bee.totals.jevUsd += extra.costUsd;
      bee.totals.decisions++;
      this.last[id] = { choice, top3, confidence: top, latencyMs: extra.latencyMs, status, ts: now };
      bus.emit("decision", {
        bee: id, choice, probabilities: top3, confidence: top, conviction: null, latencyMs: extra.latencyMs, tokens: extra.inputTokens,
        jevUsd: Number(extra.costUsd.toFixed(6)), action: describeAction(action), vetoedBy: null, forcedBy: extra.forcedBy ?? null, status,
        jev: extra.jevState, ...this.liveChip(id),
      }, now);
      return decisionId;
    };

    // 1. The stop-loss set at entry still runs every tick (the one safety floor kept).
    const mid = p ? (this.live.get(p.instId)?.mid ?? view.tickers.get(p.instId)?.mid) : undefined;
    if (p && p.stopPx !== null && mid !== undefined && (p.side === "long" ? mid <= p.stopPx : mid >= p.stopPx)) {
      const action: Action = { kind: "close", reason: "stop_loss" };
      const decisionId = record("STOP LOSS", null, action, `stop-loss hit on ${p.coin}`, { latencyMs: null, costUsd: 0, inputTokens: null, err: null, state: {}, questions: {}, forcedBy: "stop_loss", jevState: "no_options" });
      await this.execute(id, action, decisionId, this.ctx(id, now), 0);
      db.saveBee(bee, now);
      return;
    }
    // Stale market data: never trade on an old picture.
    if (now - this.d.feed.lastRefreshAt > 3 * cfg.dataRefreshMs + 30_000) {
      this.last[id] = { choice: null, top3: [], confidence: null, latencyMs: null, status: "stale market data: waiting", ts: now };
      return;
    }

    // 2. Ask Jev: yes/no questions whose answers are the orders.
    const candidates = this.controlCandidates(id, view);
    const { state, questions } = controlAsk({ strategy: brain.strategy, view, hist: this.midHist, candidates, position: p, cashUsd: bee.cashUsd, equityUsd: bee.equityUsd, now, live: this.d.alpaca ? this.live : undefined });
    const allowLocal = now - (this.lastLocalAt[id] ?? 0) >= cfg.control.localEveryMs;
    const r = await jev.askNoul(state, questions, allowLocal);
    if (r.ok && r.source === "local") this.lastLocalAt[id] = now;
    if (!r.ok) {
      // Busy native Jev with the local fallback throttled: a quiet hold, not a decision row every 5 s.
      if (r.reason === "backoff") {
        this.last[id] = { choice: null, top3: [], confidence: null, latencyMs: null, status: "Jev busy: holding", ts: now };
        return;
      }
      const status = r.reason === "daily_cap" ? "Jev daily cap hit: holding" : `Jev unreachable: holding (${r.error?.code ?? r.reason})`;
      record(null, null, { kind: "none" }, status, { latencyMs: r.latencyMs, costUsd: 0, inputTokens: null, err: `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}`, state, questions, jevState: r.reason === "daily_cap" ? "daily_cap" : "unreachable" });
      db.saveBee(bee, now);
      return;
    }
    const pick = pickControl(r.answers, questions, view, !!p);
    const src = r.source === "local" ? " [local]" : "";
    let action: Action = { kind: "none" };
    let choice: string | null = "HOLD";
    let status = pick.kind === "hold" ? pick.why : "";
    if (pick.kind === "sell") {
      action = { kind: "close", reason: "jev_sell" };
      choice = `SELL ${p!.coin}`;
      status = `Jev: sell ${p!.coin} (yes ${pick.yes.toFixed(2)})`;
    } else if (pick.kind === "buy") {
      const notional = buyNotional(bee.cashUsd, cfg.risk.takerFeeRate);
      action = { kind: "open", instId: pick.instId, side: "long", notionalUsd: notional };
      choice = `BUY ${pick.coin}`;
      status = `Jev: buy ${pick.coin} (yes ${pick.yes.toFixed(2)}), $${notional.toFixed(0)}`;
    }
    const decisionId = record(choice, r.answers, action, status + src, { latencyMs: r.latencyMs, costUsd: r.costUsd, inputTokens: r.inputTokens, err: null, state, questions, jevState: "ok" });
    if (action.kind !== "none") await this.execute(id, action, decisionId, this.ctx(id, now), 0);
    db.saveBee(bee, now);
  }

  /** Hawk's last answer survives a restart: the newest decision row that carries one. */
  private restoreHawkLast(id: BeeId): HawkLast | undefined {
    try {
      const row = this.d.db.raw
        .prepare(`SELECT ts, menu_json AS m, latency_ms AS lat, jev_cost_usd AS cost, input_tokens AS tin, jev_error AS err FROM decisions WHERE bee = ? AND menu_json LIKE '{"hawk":{%' ORDER BY id DESC LIMIT 1`)
        .get(id) as { ts: number; m: string; lat: number | null; cost: number; tin: number | null; err: string | null } | undefined;
      if (!row) return undefined;
      const m = JSON.parse(row.m) as { hawk: HawkAnswer; outputTokens?: number };
      return { answer: m.hawk, error: row.err, ts: row.ts, latencyMs: row.lat, costUsd: row.cost, inputTokens: row.tin, outputTokens: m.outputTokens ?? null };
    } catch {
      return undefined;
    }
  }

  // ---------- benched: ride the position ----------

  private async decideBenched(id: BeeId, now: number): Promise<void> {
    const { db } = this.d;
    const bee = this.bees[id];
    const ctx = this.ctx(id, now);
    const risk = applyRisk({
      ctx,
      brain: this.brain(id),
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    if (risk.capTripped) {
      db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
    }
    bee.cap = risk.cap;
    const prev = this.last[id];
    this.last[id] = { choice: null, top3: prev?.top3 ?? [], confidence: null, latencyMs: null, status: risk.status, ts: now };
    if (risk.action.kind !== "none") {
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status,
      });
      this.d.bus.emit("decision", {
        bee: id, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: describeAction(risk.action), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(id),
      }, now);
      await this.execute(id, risk.action, decisionId, ctx, 0);
    } else if (now - (this.lastPulseAt[id] ?? 0) >= PULSE_MS) {
      // Keep benched bees in the stream: a live row with the position's P&L ticking, no Jev call behind it.
      this.lastPulseAt[id] = now;
      const p = bee.position;
      this.d.bus.emit("decision", {
        bee: id, choice: p ? `RIDING ${p.coin}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status: risk.status, jev: "benched", pulse: true,
        ...this.liveChip(id),
      }, now);
    }
    db.saveBee(bee, now);
  }

  /** The bee's money right now, for the stream: open P&L (or total P&L when flat) and how it moved since its last row. */
  private liveChip(id: BeeId) {
    const b = this.bees[id];
    const p = b.position;
    const value = p ? b.uplUsd : b.equityUsd - this.d.cfg.risk.startEquityUsd;
    const prev = this.lastChipUsd[id];
    this.lastChipUsd[id] = value;
    return {
      live: {
        coin: p?.coin ?? null,
        side: p?.side ?? null,
        valueUsd: Number(value.toFixed(2)),
        kind: p ? "open" : "total",
        deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)),
      },
    };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched bee that is sitting flat
   * re-opens the last position it held (same coin, side and size, at today's price) and rides it. Not a trade
   * toward its cap. Refused outright in demo/live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    for (const id of BEES) {
      const bee = this.bees[id];
      if (this.isHawk(id) || bee.position || (bee.cap !== "trade_cap" && bee.cap !== "fee_budget")) continue;
      const last = this.d.db.raw
        .prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE bee = ? AND reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`)
        .get(id) as { instId: string; side: "buy" | "sell"; contracts: number } | undefined;
      if (!last) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "open", instId: last.instId, side: last.side === "buy" ? "long" : "short" }, vetoedBy: null, forcedBy: "resume_last",
        status: "benched: back into its last position to ride it",
      });
      const ok = await this.order(id, decisionId, last.instId, last.side, last.contracts, false, "resume_last");
      const p = (this.bees[id] as BeeState).position; // re-read: order() just filled it
      if (!ok || !p) continue;
      const ctx = this.ctx(id, this.now());
      const inst = ctx.view.instruments.get(last.instId);
      p.stopPx = this.brain(id).stopFor(last.instId, p.side, p.entryPx, ctx);
      const notional = inst ? positionNotional(p, p.entryPx, inst.ctVal) : 0;
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      this.d.db.saveBee(bee, now);
      log.info("resumed last position", { bee: id, coin: p.coin, side: p.side });
    }
  }

  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("experiment close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Close whatever each bee holds (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      BEES.map(async (id) => {
        const bee = this.bees[id];
        const p = bee.position;
        if (!p || now < (this.closeRetryAt[id] ?? 0)) return;
        const decisionId = this.d.db.insertDecision({
          bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
          conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
          action: { kind: "close", reason: "experiment_closed" }, vetoedBy: null, forcedBy: "experiment_closed", status: "experiment closed: closing position",
        });
        const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "experiment_close");
        if (!ok) this.closeRetryAt[id] = now + 10_000;
        this.d.db.saveBee(bee, now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && BEES.every((id) => !this.bees[id].position)) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: every bee is flat");
    }
  }

  // ---------- execution ----------

  private async execute(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, _conviction: number): Promise<void> {
    const bee = this.bees[id];
    const p = bee.position;
    switch (action.kind) {
      case "close":
        if (p) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, action.reason);
        return;
      case "trim": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, "trim");
        else log.info("trim rounds to zero, skipped", { bee: id });
        return;
      }
      case "add": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const s = ctx.view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) await this.order(id, decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add");
        else log.info("add rounds to zero contracts, skipped", { bee: id });
        return;
      }
      case "switch":
        if (p) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "switch_close");
          if (!ok) return;
        }
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
    }
  }

  private async openPosition(id: BeeId, decisionId: number, instId: string, side: Side, notionalUsd: number): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { bee: id, coin: inst.coin, notionalUsd });
      return;
    }
    const ok = await this.order(id, decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, "open");
    const bee = this.bees[id];
    if (!ok || !bee.position) return;
    // Hawk: decideHawk counts its trades and sets Jev's own exit plan on the new position.
    if (this.isHawk(id)) return;
    bee.tradesToday++;
    const ctx = this.ctx(id, this.now());
    const p = bee.position;
    p.stopPx = this.brain(id).stopFor(instId, side, p.entryPx, ctx);
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
    if (s.trend) p.entryScore = s.trend.score;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(id: BeeId, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return false;
    const clOrdId = `${id.slice(0, 2)}${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = db.insertOrder({ decisionId, bee: id, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const res = await exec.market(id, { instId, side, contracts, reduceOnly, clOrdId });
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { bee: id, coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      return false;
    }
    db.updateOrder(orderId, "filled", res.ordId, null);
    const bee = this.bees[id];
    const realised = applyFill(bee, { instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts });
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.insertFill({ orderId, bee: id, ts: res.ts, instId, side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: realised });
    mark(bee, res.avgPx, inst.ctVal);
    const dir = reduceOnly ? "CLOSE" : side === "buy" ? "LONG" : "SHORT";
    bus.emit("fill", {
      bee: id,
      coin: inst.coin,
      side,
      purpose,
      contracts: res.contracts,
      px: res.avgPx,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      feeUsd: Number(res.feeUsd.toFixed(4)),
      realisedUsd: Number(realised.toFixed(2)),
      label: `${this.d.cfg.slots[id].name} ${dir} ${inst.coin} $${notionalUsd.toFixed(0)}`,
    });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const id of BEES) {
      const bee = this.bees[id];
      const p = bee.position;
      const s = p ? view.stats.get(p.instId) : undefined;
      const inst = p ? view.instruments.get(p.instId) : undefined;
      if (!p || !s || !inst || s.fundingPct === null) continue;
      const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
      if (this.d.db.insertFunding(id, now, p.instId, amount, `sim-${id}-${slot}`)) {
        applyFunding(bee, amount);
        this.d.bus.emit("funding", { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
      }
    }
  }

  /** MODE=demo/live: record funding bills (type 8) as their own ledger rows. */
  private async pollFunding() {
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    for (const id of BEES.filter((b) => this.onExchange(b))) {
      const bills = await this.d.exec.fundingBills(id);
      for (const b of bills ?? []) {
        if (b.ts < since) continue;
        if (this.d.db.insertFunding(id, b.ts, b.instId, b.amountUsd, b.billId)) {
          applyFunding(this.bees[id], b.amountUsd);
          this.d.bus.emit("funding", { bee: id, coin: b.instId?.split("-")[0] ?? null, amountUsd: b.amountUsd }, b.ts);
        }
      }
    }
  }

  /** Every 5 min (demo/live): our position and fees vs OKX. On mismatch, adopt OKX's position and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconAt = now;
    const view = this.d.feed.view();
    const diffs: string[] = [];
    for (const id of BEES.filter((b) => this.onExchange(b))) {
      const bee = this.bees[id];
      const ex = await this.d.exec.positions(id);
      if (ex === null) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX positions`);
        continue;
      }
      const theirs = ex[0];
      const ours = bee.position;
      const oursSigned = ours ? (ours.side === "long" ? 1 : -1) * ours.contracts : 0;
      const theirSigned = theirs?.pos ?? 0;
      const sameInst = (ours?.instId ?? null) === (theirs?.instId ?? null);
      let ok = ex.length <= 1 && sameInst && Math.abs(oursSigned - theirSigned) < 1e-9;
      let detail = ok ? "match" : `ours ${ours ? `${ours.side} ${ours.contracts} ${ours.coin}` : "flat"} vs OKX ${theirs ? `${theirs.pos} ${theirs.instId.split("-")[0]}` : "flat"}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`)
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      if (rows.length) {
        const theirFees = await this.d.exec.feesFor(id, [...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
        if (theirFees) {
          const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((a, r) => a + r.fee, 0);
          const theirSum = [...theirFees.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(ourSum - theirSum) >= 0.005) {
            ok = false;
            detail += `; fees ours $${ourSum.toFixed(2)} vs OKX $${theirSum.toFixed(2)}`;
          }
        }
      }

      if (!sameInst || Math.abs(oursSigned - theirSigned) >= 1e-9) {
        // OKX is the truth: rebuild the position from it.
        if (!theirs) {
          bee.position = null;
          bee.flatSince ??= now;
        } else {
          const inst = view.instruments.get(theirs.instId);
          const side: Side = theirs.pos > 0 ? "long" : "short";
          const keepStop = ours && sameInst && ours.side === side ? ours.stopPx : null;
          bee.position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: ours?.openedAt ?? now,
            stopPx: keepStop ?? this.brain(id).stopFor(theirs.instId, side, theirs.avgPx, this.ctx(id, now)),
            riskUsd: ours?.riskUsd ?? (inst ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01 : 0),
          };
          bee.flatSince = null;
        }
      }
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = { ok, detail: ok ? "books match OKX" : diffs.join(" | "), ts: now };
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  /** Momentum bees: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankBoozyHourly() {
    const now = this.now();
    for (const id of BEES) {
      if (this.d.cfg.slots[id].style !== "boozy") continue;
      const bee = this.bees[id];
      if (Math.floor(now / 3_600_000) === Math.floor(bee.top1.rankedAt / 3_600_000)) continue;
      // Each Momentum bee's own ranking: a coin-restricted bee only ranks its own coins.
      const topId = this.brain(id).universe(this.ctx(id, now))[0];
      if (!topId) continue;
      const coin = coinOf(topId);
      bee.top1 = { coin, streak: coin === bee.top1.coin ? bee.top1.streak + 1 : 1, rankedAt: now };
    }
  }

  private brains = {} as Record<BeeId, BeeBrain>;

  /** Fork: bee4 is Hawk (src/hawk.ts), Jev with free rein. It has no menu brain. */
  private isHawk(id: BeeId): boolean {
    return this.d.cfg.slots[id].style === "hawk";
  }

  /** Bees with an exchange account in demo/live. Hawk is paper only and never has one. */
  private onExchange(id: BeeId): boolean {
    return !this.isHawk(id);
  }

  /** The slot's style brain, narrowed to the owner's coins and carrying the owner's rules (bees/custom.ts). */
  private brain(id: BeeId): BeeBrain {
    const s = this.d.cfg.slots[id];
    if (s.style === "hawk") throw new Error("Hawk has no menu brain");
    return (this.brains[id] ??= customBrain(BRAINS[s.style], { coins: s.coins, rules: s.rules }));
  }

  private knobs(id: BeeId) {
    return this.d.cfg.bees[this.d.cfg.slots[id].style];
  }

  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: all bees holding");
    }
  }

  private sizeMult(now: number): number {
    const { cfg } = this.d;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return 1;
    return now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1;
  }

  // ---------- read-only views for the dashboard ----------

  private publicBee(id: BeeId) {
    const b = this.bees[id];
    const view = this.d.feed.view();
    const p = b.position;
    const inst = p ? view.instruments.get(p.instId) : undefined;
    const mid = p ? view.tickers.get(p.instId)?.mid : undefined;
    const start = this.d.cfg.risk.startEquityUsd;
    const knobs = this.knobs(id);
    const r2 = (x: number) => Number(x.toFixed(2));
    return {
      bee: id,
      equityUsd: r2(b.equityUsd),
      pnlUsd: r2(b.equityUsd - start),
      pnlPct: r2(((b.equityUsd - start) / start) * 100),
      position: p
        ? {
            coin: p.coin,
            side: p.side,
            sizeUsd: inst && mid ? r2(positionNotional(p, mid, inst.ctVal)) : null,
            entryPx: p.entryPx,
            markPx: mid ?? null,
            stopPx: p.stopPx,
            uplUsd: r2(b.uplUsd),
            minutesHeld: Math.round(minutesSince(p.openedAt, this.now())),
            ...(this.isHawk(id) ? { takeProfitPx: p.takeProfitPx ?? null, invalidation: p.invalidation ?? "" } : {}),
          }
        : null,
      flatMinutes: p ? null : Math.round(minutesSince(b.flatSince, this.now())),
      tradesToday: b.tradesToday,
      maxTradesPerDay: knobs.maxTradesPerDay,
      feesTodayUsd: r2(b.feesTodayUsd),
      feeBudgetUsd: knobs.feeBudgetUsdDay,
      cap: b.cap,
      totals: { feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), jevUsd: Number(b.totals.jevUsd.toFixed(4)), realisedUsd: r2(b.totals.realisedUsd), decisions: b.totals.decisions, orders: b.totals.orders },
      maxNotionalUsd: r2(maxNotionalUsd(this.ctx(id, this.now()))),
      last: this.last[id] ?? null,
      ...(this.isHawk(id) ? { hawk: this.hawkLast[id] ?? null } : {}),
    };
  }

  snapshot() {
    const bees = BEES.map((id) => this.publicBee(id));
    const sum = (f: (b: (typeof bees)[number]) => number) => Number(bees.reduce((a, b) => a + f(b), 0).toFixed(4));
    const view = this.d.feed.view();
    return {
      ts: this.now(),
      mode: this.d.cfg.mode,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: BEES.every((id) => !this.bees[id].position) },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      tickMs: this.d.cfg.tickMs,
      bees,
      leaderboard: [...bees].sort((a, b) => b.equityUsd - a.equityUsd).map((b) => ({ bee: b.bee, equityUsd: b.equityUsd })),
      totals: { feesUsd: sum((b) => b.totals.feesUsd), fundingUsd: sum((b) => b.totals.fundingUsd), jevUsd: sum((b) => b.totals.jevUsd), pnlUsd: sum((b) => b.pnlUsd) },
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null },
      recon: this.recon,
      market: {
        refreshedAt: view.ts,
        universe: view.gated.map((i) => i.split("-")[0]),
        spreadBlocked: view.spreadBlocked.map((i) => ({ coin: i.split("-")[0], spreadBp: Number((view.tickers.get(i)?.spreadBp ?? 0).toFixed(1)) })),
        attention: view.newsAvailable ? "news" : "volume",
      },
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    return { ok: this.d.feed.lastRefreshAt > 0 && age < 5 * this.d.cfg.dataRefreshMs, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: BEES.every((id) => !this.bees[id].position), marketAgeMs: age, uptimeS: Math.round((this.now() - this.startedAt) / 1000) };
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case "none":
      return "hold";
    case "close":
      return `close (${a.reason})`;
    case "trim":
      return `trim ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "switch":
      return `switch to ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
  }
}
