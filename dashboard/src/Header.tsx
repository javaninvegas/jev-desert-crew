import { useEffect, useState } from "react";
import { money, signed } from "./BeeColumn";
import { PROFILE, type Snapshot } from "./types";

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Recon({ recon, mode }: { recon: Snapshot["recon"] | undefined; mode: Snapshot["mode"] | undefined }) {
  const state = !recon || recon.ok === null ? "idle" : recon.ok ? "ok" : "bad";
  const text =
    state === "ok" ? "books match OKX to the cent" : state === "bad" ? recon!.detail : mode === "dry" ? "paper trading: simulated books" : "first check pending";
  return (
    <div className={`recon recon-${state}`} title={recon?.detail}>
      <span className="recon-light" aria-hidden />
      <div>
        <div className="eyebrow">Reconciliation</div>
        <div className="recon-text">{state === "ok" ? "✓ " : state === "bad" ? "✗ " : ""}{text}</div>
      </div>
    </div>
  );
}

function Counter({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="counter">
      <div className="eyebrow">{label}</div>
      <div className={`counter-value num ${tone ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

export function Header({ snap, connected, stalled, soundOn, onSound }: { snap: Snapshot | null; connected: boolean; stalled: boolean; soundOn: boolean; onSound: () => void }) {
  const day = snap?.startedAt ? Math.floor((Date.now() - snap.startedAt) / 86_400_000) + 1 : 1;
  const t = snap?.totals;
  const jev = snap?.jev;
  const orders = snap?.bees.reduce((a, b) => a + b.totals.orders, 0) ?? 0;
  const decisions = snap?.bees.reduce((a, b) => a + b.totals.decisions, 0) ?? 0;
  const live = connected && !stalled;
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-row">
          <div className="logo">Tortoise · Coyote · Roadrunner · Hawk</div>
        </div>
        <div className="brand-sub">
          <span className={`mode mode-${snap?.mode ?? "dry"}`}>{snap?.mode === "live" ? "● LIVE MONEY" : snap?.mode === "demo" ? "OKX DEMO" : "PAPER TRADING"}{snap?.closed ? (snap.closed.flat ? " · ENDED" : " · CLOSING") : ""}</span>
          {snap?.update ? (
            <a className="update-pill" href={`${PROFILE.links?.code ?? "https://github.com/imikerussell/beebots"}/releases/latest`} target="_blank" rel="noopener" title={`You run ${snap.update.current}. See what's new and how to update.`}>
              Update available: {snap.update.latest} ↗
            </a>
          ) : null}
          <span className="dim">
            day {day} · 4 bots · paper money · not financial advice
          </span>
        </div>
      </div>

      <div className="counters">
        <Counter label="Total P&L" value={t ? signed(t.pnlUsd) : "–"} tone={t ? (t.pnlUsd >= 0 ? "good" : "bad") : undefined} sub={`${orders} orders`} />
        <Counter label="Fees paid" value={t ? money(t.feesUsd) : "–"} sub="Crypto.com taker 0.50%" />
        <Counter label="Funding" value={t ? signed(t.fundingUsd) : "–"} sub="00 · 08 · 16 UTC" />
        <Counter
          label="Jev spend"
          value={t ? money(t.jevUsd, 4) : "–"}
          sub={jev ? `today ${money(jev.spentTodayUsd, 3)} of ${money(jev.dailyCapUsd, 0)} cap` : undefined}
        />
        <Counter label="Decisions" value={decisions.toLocaleString()} sub={jev?.down ? "Jev unreachable: holding" : jev?.capTripped ? "Jev cap hit: holding" : "every one recorded"} tone={jev?.down || jev?.capTripped ? "bad" : undefined} />
        <Counter label="Visitors" value={snap?.visitors ? snap.visitors.total.toLocaleString() : "–"} sub={snap?.visitors ? `${snap.visitors.watching} watching now` : undefined} />
        {/* fork: hosting/sponsor link removed */}
      </div>

      <div className="top-right">
        <Recon recon={snap?.recon} mode={snap?.mode} />
        <div className="conn">
          <span className={`conn-dot ${live ? "on" : "off"}`} />
          <span>{live ? "live" : connected ? "stalled" : "reconnecting"}</span>
          <Clock />
          <button className={`sound ${soundOn ? "on" : ""}`} onClick={onSound} aria-pressed={soundOn}>
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </div>
    </header>
  );
}
