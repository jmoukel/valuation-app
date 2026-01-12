import { NextResponse } from "next/server";
import { calculateRule1 } from "@/lib/valuations/rule1";

/* ---------------------------
   Tiny helpers
---------------------------- */

function cleanTicker(input: string | null): string {
  const t = (input ?? "").trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(t)) throw new Error("Invalid ticker");
  return t;
}

function yearFromISODate(iso: string): number {
  return Number(iso.slice(0, 4));
}

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function keepMostCommonFiscalYearEndMonth(series: YearPoint[]): YearPoint[] {
  if (series.length === 0) return series;

  const monthCounts = new Map<number, number>();
  for (const p of series) {
    const m = Number(p.end.slice(5, 7)); // "YYYY-MM-DD" -> month
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }

  let bestMonth = -1;
  let bestCount = -1;
  for (const [m, c] of monthCounts.entries()) {
    if (c > bestCount) {
      bestMonth = m;
      bestCount = c;
    }
  }

  return series.filter((p) => Number(p.end.slice(5, 7)) === bestMonth);
}

function pickDebtNearestToEndDate(facts: any, endDate: string): number | null {
  const candidates: Array<{ end: string; val: number }> = [];

  const tryTag = (tag: string) => {
    const units = facts?.facts?.["us-gaap"]?.[tag]?.units?.["USD"];
    if (!Array.isArray(units)) return;
    for (const x of units) {
      if (!x || typeof x.end !== "string" || !isFiniteNumber(x.val)) continue;
      candidates.push({ end: x.end, val: x.val });
    }
  };

  tryTag("LongTermDebtNoncurrent");
  tryTag("LongTermDebt");

  if (candidates.length === 0) return null;

  let best: { end: string; val: number } | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const c of candidates) {
    const a = Number(c.end.replaceAll("-", ""));
    const b = Number(endDate.replaceAll("-", ""));
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }

  return best ? best.val : null;
}

function pickNearestUSDValue(facts: any, tagCandidates: string[], endDate: string, maxDays: number): number | null {
  const candidates: Array<{ end: string; val: number }> = [];

  for (const tag of tagCandidates) {
    const arr = facts?.facts?.["us-gaap"]?.[tag]?.units?.["USD"];
    if (!Array.isArray(arr)) continue;

    for (const x of arr) {
      if (!x || typeof x.end !== "string" || !isFiniteNumber(x.val)) continue;
      candidates.push({ end: x.end, val: x.val });
    }
  }

  if (candidates.length === 0) return null;

  const target = Number(endDate.replaceAll("-", ""));
  let best: { end: string; val: number } | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const c of candidates) {
    const d = Number(c.end.replaceAll("-", ""));
    const diff = Math.abs(d - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }

  if (!best) return null;

  // crude day window check: treat YYYYMMDD difference as a proxy and be conservative
  // maxDays=200 is usually safe for matching around fiscal year end
  if (bestDiff > maxDays * 10) return null;

  return best.val;
}

function mergeAnnualUSDSeries(facts: any, tagCandidates: string[]): YearPoint[] {
  const all: YearPoint[] = [];

  for (const tag of tagCandidates) {
    const node = facts?.facts?.["us-gaap"]?.[tag]?.units?.["USD"];
    if (!Array.isArray(node)) continue;

    for (const x of node) {
      if (!x) continue;
      if (x.form !== "10-K") continue;
      if (x.fp !== "FY") continue;
      if (typeof x.end !== "string") continue;
      if (!isFiniteNumber(x.val)) continue;
      if (typeof x.frame === "string" && /Q[1-4]/.test(x.frame)) continue;

      all.push({ end: x.end, val: x.val });
    }
  }

  const byEnd = new Map<string, number>();
  for (const p of all) {
    const prev = byEnd.get(p.end);
    if (prev === undefined || Math.abs(p.val) > Math.abs(prev)) {
      byEnd.set(p.end, p.val);
    }
  }

  return Array.from(byEnd.entries())
    .map(([end, val]) => ({ end, val }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

type StockSplit = {
  effectiveDate: string; // YYYY-MM-DD
  ratio: number;         // e.g. 4 for 4-for-1
};

const SPLITS_BY_TICKER: Record<string, StockSplit[]> = {
  AAPL: [
    { effectiveDate: "2020-08-31", ratio: 4 },
  ],
};

function cumulativeSplitFactor(
  ticker: string,
  endDate: string
): number {
  const splits = SPLITS_BY_TICKER[ticker] ?? [];
  let factor = 1;

  for (const s of splits) {
    if (endDate < s.effectiveDate) {
      factor *= s.ratio;
    }
  }

  return factor;
}

/* ---------------------------
   PRICE (Stooq, latest close)
---------------------------- */

function parseStooqClose(csvText: string): number | null {
  const lines = csvText
    .replaceAll("\r", "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const first = lines[0];

  if (first.toLowerCase().includes("close")) {
    if (lines.length < 2) return null;

    const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
    const row = lines[1].split(",").map((s) => s.trim());

    const closeIndex = header.indexOf("close");
    if (closeIndex === -1) return null;

    const close = Number(row[closeIndex]);
    return Number.isFinite(close) ? close : null;
  }

  // No header case: Symbol,Date,Time,Open,High,Low,Close,Volume
  const parts = first.split(",").map((s) => s.trim());
  if (parts.length < 7) return null;

  const close = Number(parts[6]);
  return Number.isFinite(close) ? close : null;
}

async function fetchStooqLatestCloseUSD(ticker: string): Promise<number | null> {
  const stooqSymbol = `${ticker}.US`.toLowerCase();
  const stooqUrl = `https://stooq.com/q/l/?s=${stooqSymbol}&i=d`;

  const res = await fetch(stooqUrl, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*" },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Stooq latest failed: status=${res.status}. Body=${text}`);

  return parseStooqClose(text);
}

/* ---------------------------
   PRICE (Stooq, daily history)
   Used for 10y P/E
---------------------------- */

type DailyClose = { date: string; close: number };

// Cache by symbol so repeated calls are fast while dev server stays running
const stooqHistoryCache = new Map<string, DailyClose[]>();

async function fetchStooqDailyHistory(ticker: string): Promise<DailyClose[]> {
  const key = ticker.toUpperCase();
  const cached = stooqHistoryCache.get(key);
  if (cached) return cached;

  const stooqSymbol = `${ticker}.US`.toLowerCase();

  // This endpoint returns CSV with header:
  // Date,Open,High,Low,Close,Volume
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol}&i=d`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*" },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Stooq history failed: status=${res.status}. Body=${text}`);

  const lines = text
    .replaceAll("\r", "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf("close");
  if (dateIdx === -1 || closeIdx === -1) return [];

  const out: DailyClose[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((s) => s.trim());
    const date = parts[dateIdx];
    const close = Number(parts[closeIdx]);
    if (typeof date === "string" && date.length >= 10 && Number.isFinite(close)) {
      out.push({ date, close });
    }
  }

  // Stooq is usually oldest to newest, but we will sort just in case
  out.sort((a, b) => a.date.localeCompare(b.date));

  stooqHistoryCache.set(key, out);
  return out;
}

function closeOnOrBefore(history: DailyClose[], isoDate: string): number | null {
  // history is sorted by date ascending
  // We find the last record with date <= isoDate
  let lo = 0;
  let hi = history.length - 1;
  let ans = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].date <= isoDate) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return ans >= 0 ? history[ans].close : null;
}

/* ---------------------------
   FUNDAMENTALS (SEC EDGAR)
---------------------------- */

// Replace with an email you are comfortable using
const SEC_USER_AGENT = "Jorge valuation app (your-email@example.com)";

let tickerToCikCache: Record<string, string> | null = null;

async function getTickerToCikMap(): Promise<Record<string, string>> {
  if (tickerToCikCache) return tickerToCikCache;

  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_USER_AGENT, "Accept": "application/json" },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SEC ticker map failed: status=${res.status}. Body=${text}`);

  const data = JSON.parse(text);

  const map: Record<string, string> = {};
  for (const key of Object.keys(data)) {
    const row = data[key];
    const ticker = String(row.ticker ?? "").toUpperCase();
    const cikRaw = String(row.cik_str ?? "");
    if (!ticker || !cikRaw) continue;

    map[ticker] = cikRaw.padStart(10, "0");
  }

  tickerToCikCache = map;
  return map;
}

async function getCikForTicker(ticker: string): Promise<string> {
  const map = await getTickerToCikMap();
  const cik10 = map[ticker.toUpperCase()];
  if (!cik10) throw new Error(`No SEC CIK found for ticker ${ticker}`);
  return cik10;
}

async function fetchCompanyFacts(cik10: string): Promise<any> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

  const res = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT, "Accept": "application/json" },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SEC companyfacts failed: status=${res.status}. Body=${text}`);

  return JSON.parse(text);
}

type YearPoint = { end: string; val: number };

function pickAnnualSeriesByUnit(
  facts: any,
  tagCandidates: string[],
  unitPredicate: (unitKey: string) => boolean
): YearPoint[] {
  for (const tag of tagCandidates) {
    const node = facts?.facts?.["us-gaap"]?.[tag]?.units;
    if (!node || typeof node !== "object") continue;

    const unitKeys = Object.keys(node);
    const unitKey = unitKeys.find(unitPredicate);
    if (!unitKey) continue;

    const arr = node[unitKey];
    if (!Array.isArray(arr)) continue;

    const annualRaw = arr
    .filter((x: any) => {
      if (!x) return false;
      if (x.form !== "10-K") return false;
      if (x.fp !== "FY") return false;
      if (typeof x.end !== "string") return false;
      if (!isFiniteNumber(x.val)) return false;

      // Important: exclude frames that look like quarters (CY2023Q1, FY2024Q2, etc.)
      if (typeof x.frame === "string" && /Q[1-4]/.test(x.frame)) return false;

      return true;
    })
    .map((x: any) => ({ end: x.end as string, val: x.val as number }));

    // Deduplicate by end date: if SEC gives duplicates for the same end date,
    // keep the biggest absolute value (usually the real annual total).
    const byEnd = new Map<string, number>();
    for (const p of annualRaw) {
    const prev = byEnd.get(p.end);
    if (prev === undefined || Math.abs(p.val) > Math.abs(prev)) {
      byEnd.set(p.end, p.val);
    }
    }

    const annual = Array.from(byEnd.entries())
    .map(([end, val]) => ({ end, val }))
    .sort((a, b) => a.end.localeCompare(b.end));

    if (annual.length) return annual;
  }
  return [];
}

function pickAnnualUSDSeries(facts: any, tagCandidates: string[]): YearPoint[] {
  return pickAnnualSeriesByUnit(facts, tagCandidates, (u) => u === "USD");
}

function pickAnnualEPSSeries(facts: any, tagCandidates: string[]): YearPoint[] {
  // EPS is usually "USD/shares"
  return pickAnnualSeriesByUnit(facts, tagCandidates, (u) => u.toLowerCase().includes("usd") && u.toLowerCase().includes("shares"));
}

function pickLatestValue(facts: any, tagCandidates: string[], unitKey: string): { end: string; val: number } | null {
  for (const tag of tagCandidates) {
    const arr = facts?.facts?.["us-gaap"]?.[tag]?.units?.[unitKey];
    if (!Array.isArray(arr)) continue;

    const sorted = arr
      .filter((x: any) => x && typeof x.end === "string" && isFiniteNumber(x.val))
      .map((x: any) => ({ end: x.end as string, val: x.val as number }))
      .sort((a, b) => b.end.localeCompare(a.end));

    if (sorted.length) return sorted[0];
  }
  return null;
}

function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00Z").getTime();
  const b = new Date(bISO + "T00:00:00Z").getTime();
  return Math.abs(Math.round((a - b) / (1000 * 60 * 60 * 24)));
}

function pickSharesNearestToEndDate(facts: any, endDate: string): number | null {
  const shareTags = [
    "CommonStockSharesOutstanding",
    "EntityCommonStockSharesOutstanding",
  ];

  const candidates: Array<{ end: string; val: number }> = [];

  for (const tag of shareTags) {
    const unitsObj = facts?.facts?.["us-gaap"]?.[tag]?.units;
    if (!unitsObj || typeof unitsObj !== "object") continue;

    // Some companies use "shares", others use "shares" with weird capitalization
    const unitKey = Object.keys(unitsObj).find((k) => k.toLowerCase() === "shares");
    if (!unitKey) continue;

    const arr = unitsObj[unitKey];
    if (!Array.isArray(arr)) continue;

    for (const x of arr) {
      if (!x || typeof x.end !== "string" || !isFiniteNumber(x.val)) continue;
      candidates.push({ end: x.end, val: x.val });
    }
  }

  if (candidates.length === 0) return null;

  let best: { end: string; val: number } | null = null;
  let bestDays = Number.POSITIVE_INFINITY;

  for (const c of candidates) {
    const d = daysBetween(c.end, endDate);
    if (d < bestDays) {
      bestDays = d;
      best = c;
    }
  }

  // Only accept if within ~180 days of fiscal year end
  if (!best || bestDays > 180) return null;

  return best.val;
}

function lastNYears(series: YearPoint[], n: number): YearPoint[] {
  if (series.length <= n) return series;
  return series.slice(series.length - n);
}

/* ---------------------------
   Metrics computation
---------------------------- */

type YearMetric = { end: string; val: number | null };

function alignByEnd(ends: string[], lookup: Map<string, number>): YearMetric[] {
  return ends.map((end) => ({ end, val: lookup.has(end) ? lookup.get(end)! : null }));
}

function toMap(series: YearPoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of series) m.set(p.end, p.val);
  return m;
}

function numParam(url: URL, key: string, def: number): number {
  const v = url.searchParams.get(key);
  const n = v !== null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = cleanTicker(url.searchParams.get("ticker"));
    const years = Math.max(1, Math.round(numParam(url, "years", 10)));
    const analystGrowth = numParam(url, "growth", 0.10); // 10% default
    const desiredReturn = numParam(url, "return", 0.2); // 20% default
    const marginOfSafetyPercent = numParam(url, "mos", 40); // 40% default

    const price = await fetchStooqLatestCloseUSD(ticker);

    const cik10 = await getCikForTicker(ticker);
    const facts = await fetchCompanyFacts(cik10);
      
    const growthBasisRaw = url.searchParams.get("growthBasis") ?? "bvps_5y";

    const growthBasis =
    growthBasisRaw === "bvps_5y" ||
    growthBasisRaw === "bvps_10y" ||
    growthBasisRaw === "fcf_5y" ||
    growthBasisRaw === "fcf_10y" ||
    growthBasisRaw === "eps_5y" ||
    growthBasisRaw === "eps_10y"
      ? growthBasisRaw
      : "bvps_5y";

    // 10 years annual series
    const revenueRaw = mergeAnnualUSDSeries(facts, [
        "Revenues",
        "SalesRevenueNet",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet",
      ]);
    const revenue = lastNYears(keepMostCommonFiscalYearEndMonth(revenueRaw), 10);
    const epsRaw = pickAnnualEPSSeries(facts, ["EarningsPerShareDiluted", "EarningsPerShareBasic"]);
    const eps = lastNYears(keepMostCommonFiscalYearEndMonth(epsRaw), 10);

    const ocf = lastNYears(
      pickAnnualUSDSeries(facts, ["NetCashProvidedByUsedInOperatingActivities"]),
      10
    );

    const capex = lastNYears(
      pickAnnualUSDSeries(facts, ["PaymentsToAcquirePropertyPlantAndEquipment"]),
      10
    );

    const equity = lastNYears(
        pickAnnualUSDSeries(facts, [
          "StockholdersEquity",
          "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        ]),
        10
    );

    const opIncome = lastNYears(pickAnnualUSDSeries(facts, ["OperatingIncomeLoss"]), 10);
    const pretax = lastNYears(
        pickAnnualUSDSeries(facts, [
          "IncomeBeforeIncomeTaxes",
          "ProfitLoss",
          "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        ]),
        10
    );
    const taxes = lastNYears(pickAnnualUSDSeries(facts, ["IncomeTaxExpenseBenefit"]), 10);

    const cash = lastNYears(
        pickAnnualUSDSeries(facts, [
          "CashAndCashEquivalentsAtCarryingValue",
          "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        ]),
        10
    );

    // Current long term debt (latest value, not necessarily FY)
    const ltdLatest =
      pickLatestValue(facts, ["LongTermDebtNoncurrent", "LongTermDebt"], "USD");

    // Compute FCF per year = OCF - CapEx (aligned by end dates)
    const ends = eps.map((e) => e.end);

    const ocfMap = toMap(ocf);
    const capexMap = toMap(capex);

    const fcf: YearMetric[] = ends.map((end) => {
      const o = ocfMap.get(end);
      const c = capexMap.get(end);
      if (!isFiniteNumber(o) || !isFiniteNumber(c)) return { end, val: null };
      return { end, val: o - c };
    });

    // Book value per share per year = equity / shares nearest that year end
    const equityMap = toMap(equity);
    const bookValuePerShareUSD: YearMetric[] = ends.map((end) => {
      const eq =
          equityMap.get(end) ??
          pickNearestUSDValue(
            facts,
            ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
            end,
            200
          );

      const sh = pickSharesNearestToEndDate(facts, end);
      if (!isFiniteNumber(eq) || !isFiniteNumber(sh) || sh <= 0) return { end, val: null };
      return { end, val: eq / sh };
    });
      
    const bookValuePerShareUSD_splitAdjusted = bookValuePerShareUSD.map((p) => {
    if (!Number.isFinite(p.val)) return p;

    const factor = cumulativeSplitFactor(ticker, p.end);
    return {
      end: p.end,
      val: p.val === null ? null : p.val / factor,
    };
    });

    // ROIC per year (v1 definition)
    // NOPAT = OperatingIncome * (1 - taxRate)
    // taxRate = taxes / pretax
    // investedCapital = equity + longTermDebt - cash
    const opMap = toMap(opIncome);
    const pretaxMap = toMap(pretax);
    const taxMap = toMap(taxes);
    const cashMap = toMap(cash);

    const roic: YearMetric[] = ends.map((end) => {
      const op = opMap.get(end);
      const pt = pretaxMap.get(end);
      const tx = taxMap.get(end);
      const eq =
        equityMap.get(end) ??
        pickNearestUSDValue(
        facts,
        ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
        end,
        200
        );

        const ca =
        cashMap.get(end) ??
        pickNearestUSDValue(
        facts,
        ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
        end,
        200
      );
      const debt = pickDebtNearestToEndDate(facts, end);

      if (![op, pt, tx, eq, ca, debt].every(isFiniteNumber)) return { end, val: null };
      if (ca === undefined || debt === undefined || eq === undefined || op === undefined || pt === undefined || pt === 0 || tx === undefined || tx === null) return { end, val: null };

      const taxRate = Math.max(0, Math.min(1, tx / pt));
      const nopat = op * (1 - taxRate);
      const investedCapital = eq + debt - ca;

      if (!Number.isFinite(investedCapital) || investedCapital <= 0) return { end, val: null };
      return { end, val: nopat / investedCapital };
    });

    // Average P/E last 10 years
    // For each fiscal year end, use close on or before that date, divided by EPS for that year.
    const history = await fetchStooqDailyHistory(ticker);
    const epsMap = toMap(eps);

    const peByYear: YearMetric[] = ends.map((end) => {
      const e = epsMap.get(end);
      if (!isFiniteNumber(e) || e <= 0) return { end, val: null };

      const px = closeOnOrBefore(history, end);
      if (!isFiniteNumber(px)) return { end, val: null };

      return { end, val: px / e };
    });

    const peValues = peByYear.map((p) => p.val).filter((v): v is number => isFiniteNumber(v));
    const averagePe10y = peValues.length ? peValues.reduce((a, b) => a + b, 0) / peValues.length : null;
      
      const rule1 = calculateRule1(
        {
          eps: eps,
          bookValuePerShareUSD: bookValuePerShareUSD,
          freeCashFlowUSD: fcf, // REQUIRED for fcf_5y / fcf_10y
          historicPeRatio: averagePe10y,
          latestPriceUSD: price,
        },
        {
          years: years,
          analystGrowth: analystGrowth,
          desiredReturn: desiredReturn,
          marginOfSafetyPercent: marginOfSafetyPercent,
          growthBasis: growthBasis, // REQUIRED to know which basis to compute
        }
      );

    // Return what you asked for, clearly labeled
    return NextResponse.json({
      ticker,
      cik: cik10,

      latestPriceUSD: price,
      latestPriceSource: "stooq_latest",

      revenueUSD: revenue,
      eps: eps,
      freeCashFlowUSD: fcf,
      bookValuePerShareUSD: bookValuePerShareUSD_splitAdjusted,
      roic: roic,

      longTermDebtUSD_current: ltdLatest ? { end: ltdLatest.end, val: ltdLatest.val } : null,

      peRatioByYear: peByYear,
      averagePeRatio10y: averagePe10y,
        
        valuations: {
          rule1: {
            assumptions: { years, analystGrowth, desiredReturn, marginOfSafetyPercent, growthBasis },
            result: rule1,
          },
        },

      notes: {
        roicDefinition:
          "ROIC = NOPAT / InvestedCapital, NOPAT = OperatingIncome*(1-taxRate), taxRate=Taxes/Pretax, InvestedCapital=Equity+LongTermDebt-Cash",
        peDefinition:
          "P/E per year = (close on or before fiscal year end) / (EPS for that fiscal year). Average is mean of available years with EPS>0.",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 400 }
    );
  }
}
