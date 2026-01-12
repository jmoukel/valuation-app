"use client";

import { useEffect, useMemo, useState } from "react";

type GrowthBasis =
  | "bvps_5y"
  | "bvps_10y"
  | "fcf_5y"
  | "fcf_10y"
  | "eps_5y"
  | "eps_10y";

const GROWTH_OPTIONS: Array<{ key: GrowthBasis; label: string }> = [
  { key: "bvps_5y", label: "BVPS last 5 years" },
  { key: "bvps_10y", label: "BVPS last 10 years" },
  { key: "fcf_5y", label: "Free Cash Flow last 5 years" },
  { key: "fcf_10y", label: "Free Cash Flow last 10 years" },
  { key: "eps_5y", label: "EPS last 5 years" },
  { key: "eps_10y", label: "EPS last 10 years" },
];

type Rule1Failure = {
  error: {
    type: string;
    message: string;
    growthBasis?: GrowthBasis;
    pointsNeeded?: number;
    pointsAvailable?: number;
  };
};

type Rule1Result = {
  latestEps: number;
  basis: {
    key: GrowthBasis;
    label: string;
    pointsUsed: number;
    yearsActual: number;
    startEnd: string;
    endEnd: string;
    startVal: number;
    endVal: number;
    growth: number;
  };
  chosenGrowth: number;
  historicPeUsed: number;
  futureValue: number;
  stickerPrice: number;
  stickerPriceWithMOS: number;
  currentPrice: number | null;
};

type Rule1ResultOrFailure = Rule1Result | Rule1Failure;

type ApiResponse = {
  ticker: string;
  latestPriceUSD: number | null;
  valuations?: {
    rule1?: {
      assumptions?: {
        years: number;
        analystGrowth: number;
        desiredReturn: number;
        marginOfSafetyPercent: number;
        growthBasis: GrowthBasis;
      };
      result?: Rule1ResultOrFailure | null;
    };
  };
  error?: string;
};

function fmtMoney(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(x);
}

function fmtPct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "N/A";
  return (x * 100).toFixed(2) + "%";
}

export default function HomePage() {
  const [ticker, setTicker] = useState("AAPL");

  const [years, setYears] = useState(10);
  const [analystGrowth, setAnalystGrowth] = useState(0.12);
  const [desiredReturn, setDesiredReturn] = useState(0.2);
  const [mosPercent, setMosPercent] = useState(40);

  const [growthBasis, setGrowthBasis] = useState<GrowthBasis>("bvps_5y");

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const queryUrl = useMemo(() => {
    const t = ticker.trim().toUpperCase();
    const params = new URLSearchParams();
    params.set("ticker", t);
    params.set("years", String(years));
    params.set("growth", String(analystGrowth));
    params.set("return", String(desiredReturn));
    params.set("mos", String(mosPercent));
    params.set("growthBasis", growthBasis);
    params.set("pretty", "1");
    return "/api/financials?" + params.toString();
  }, [ticker, years, analystGrowth, desiredReturn, mosPercent, growthBasis]);

  const [debouncedQueryUrl, setDebouncedQueryUrl] = useState(queryUrl);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQueryUrl(queryUrl), 300);
    return () => clearTimeout(id);
  }, [queryUrl]);

  useEffect(() => {
    const t = ticker.trim();
    if (!t) return;

    let cancelled = false;
    setLoading(true);
    setErr(null);

    fetch(debouncedQueryUrl)
      .then(async (r) => {
        const j = (await r.json()) as ApiResponse;
        if (cancelled) return;
        if (!r.ok) {
          setErr(j?.error ?? "Request failed");
          setData(null);
          return;
        }
        setData(j);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(String(e));
        setData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQueryUrl, ticker]);

  const rule1 = data?.valuations?.rule1?.result ?? null;
  const rule1Error = rule1 && typeof rule1 === "object" && "error" in rule1 ? (rule1 as Rule1Failure).error : null;
  const rule1Ok = rule1 && typeof rule1 === "object" && !("error" in rule1) ? (rule1 as Rule1Result) : null;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Valuation Tool</h1>
      <div style={{ color: "#555", marginBottom: 24 }}>
        Rule #1 valuation (your method). Buffett method later.
      </div>

      <section style={{ padding: 16, border: "1px solid #ddd", borderRadius: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Inputs</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            Ticker
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL"
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            />
          </label>

          <label>
            Years into future
            <input
              type="number"
              value={years}
              onChange={(e) => setYears(Math.max(1, Math.round(Number(e.target.value) || 0)))}
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            />
          </label>

          <label>
            Analyst growth (decimal)
            <input
              type="number"
              step="0.01"
              value={analystGrowth}
              onChange={(e) => setAnalystGrowth(Number(e.target.value) || 0)}
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            />
            <div style={{ color: "#666", marginTop: 6 }}>Example: 0.12 means 12%</div>
          </label>

          <label>
            Desired return (decimal)
            <input
              type="number"
              step="0.01"
              value={desiredReturn}
              onChange={(e) => setDesiredReturn(Number(e.target.value) || 0)}
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            />
            <div style={{ color: "#666", marginTop: 6 }}>Example: 0.15 means 15%</div>
          </label>

          <label>
            Margin of safety (percent)
            <input
              type="number"
              step="1"
              value={mosPercent}
              onChange={(e) =>
                setMosPercent(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))
              }
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            />
            <div style={{ color: "#666", marginTop: 6 }}>Example: 50 means 50%</div>
          </label>
        </div>

        <div style={{ marginTop: 12, color: "#666" }}>
          API request (debounced): <code>{debouncedQueryUrl}</code>
        </div>
      </section>

      <section style={{ padding: 16, border: "1px solid #ddd", borderRadius: 12 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Rule #1 Output</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <label>
            Growth basis (min with analyst growth)
            <select
              value={growthBasis}
              onChange={(e) => setGrowthBasis(e.target.value as GrowthBasis)}
              style={{ width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ccc" }}
            >
              {GROWTH_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <div style={{ color: "#666" }}>
              Rule #1 uses <strong>min(analyst growth, basis growth)</strong>.
            </div>
          </div>
        </div>

        {loading && <div>Loading...</div>}

        {!loading && err && <div style={{ color: "crimson" }}>Error: {err}</div>}

        {!loading && !err && rule1Error && (
          <div style={{ color: "orange" }}>
            <strong>Rule #1 unavailable</strong>
            <div style={{ marginTop: 6 }}>{rule1Error.message}</div>
            <div style={{ marginTop: 6, color: "#666" }}>
              Try a different growth basis (for example EPS 5y or BVPS 5y).
            </div>
          </div>
        )}

        {!loading && !err && rule1Ok && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Current price</div>
              <div style={{ fontSize: 22 }}>{fmtMoney(rule1Ok.currentPrice)}</div>
            </div>

            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Sticker price</div>
              <div style={{ fontSize: 22 }}>{fmtMoney(rule1Ok.stickerPrice)}</div>
            </div>

            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Sticker price with MOS</div>
              <div style={{ fontSize: 22 }}>{fmtMoney(rule1Ok.stickerPriceWithMOS)}</div>
            </div>

            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Chosen growth (min)</div>
              <div style={{ fontSize: 22 }}>{fmtPct(rule1Ok.chosenGrowth)}</div>
            </div>

            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Selected basis</div>
              <div style={{ fontSize: 18, marginTop: 6 }}>{rule1Ok.basis.label}</div>

              <div style={{ marginTop: 10, color: "#666" }}>Basis values used</div>
              <div style={{ color: "#666", marginTop: 6 }}>
                End ({rule1Ok.basis.endEnd}): {fmtMoney(rule1Ok.basis.endVal)}
              </div>
              <div style={{ color: "#666", marginTop: 2 }}>
                Start ({rule1Ok.basis.startEnd}): {fmtMoney(rule1Ok.basis.startVal)}
              </div>

              <div style={{ marginTop: 10, color: "#666" }}>Basis growth (CAGR)</div>
              <div style={{ fontSize: 22, marginTop: 4 }}>{fmtPct(rule1Ok.basis.growth)}</div>

              <div style={{ color: "#666", marginTop: 6 }}>
                Span: about {rule1Ok.basis.yearsActual} years (using {rule1Ok.basis.pointsUsed} annual points)
              </div>
            </div>

            <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ color: "#666" }}>Historic PE used</div>
              <div style={{ fontSize: 22 }}>{rule1Ok.historicPeUsed.toFixed(2)}</div>
            </div>
          </div>
        )}
      </section>

      <section style={{ marginTop: 16 }}>
        <details>
          <summary style={{ cursor: "pointer" }}>Show raw API response</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{data ? JSON.stringify(data, null, 2) : ""}</pre>
        </details>
      </section>
    </main>
  );
}