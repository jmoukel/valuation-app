import { NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

function asNumber(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
  const years = Math.max(2, Math.round(Number(url.searchParams.get("years") ?? "5") || 5));

  if (!ticker) {
    return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
  }

  const finnhubToken = process.env.FINNHUB_API_KEY ?? "";

    if (finnhubToken) {
        const finnhubUrl =
        "https://finnhub.io/api/v1/stock/eps-estimate" +
        `?symbol=${encodeURIComponent(ticker)}` +
        `&token=${encodeURIComponent(finnhubToken)}`;
        
        try {
            const r = await fetch(finnhubUrl, { headers: { accept: "application/json" }, cache: "no-store" });
            const text = await r.text().catch(() => "");
            
            if (r.ok) {
                const json = text ? JSON.parse(text) : null;
                const rows: any[] = Array.isArray(json?.data) ? json.data : [];
                if (rows.length >= 2) {
                    const yearToEps = new Map<number, number>();
                    for (const row of rows) {
                        const y = asNumber(row.year) ?? asNumber(String(row.period ?? "").slice(0, 4));
                        const eps = asNumber(row.epsAvg) ?? asNumber(row.eps) ?? asNumber(row.estimate);
                        if (y && eps !== null) yearToEps.set(y, eps);
                    }
                    const points = Array.from(yearToEps.entries())
                    .map(([year, eps]) => ({ year, eps }))
                    .sort((a, b) => a.year - b.year);
                    
                    if (points.length >= 2) {
                        const start = points[0];
                        const targetYear = start.year + years;
                        const end = points.find((p) => p.year >= targetYear) ?? points[points.length - 1];
                        const yearsActual = Math.max(1, end.year - start.year);
                        const analystGrowth =
                        start.eps > 0 && end.eps > 0 ? Math.pow(end.eps / start.eps, 1 / yearsActual) - 1 : null;
                        
                        if (analystGrowth !== null) {
                            return NextResponse.json(
                                                     { ticker, analystGrowth, source: "finnhub", yearsRequested: years, yearsActual, start, end },
                                                     { status: 200 }
                                                     );
                        }
                    }
                }
            }
            
            if (!r.ok && r.status !== 403) {
                return NextResponse.json(
                                         {
                                             ticker,
                                             analystGrowth: null,
                                             source: "finnhub",
                                             reason: `Finnhub returned ${r.status}`,
                                             details: text.slice(0, 300),
                                         },
                                         { status: 200 }
                                         );
            }
        } catch (e) {
            // Ignore and fall through to Yahoo fallback
        }
    }

    // Yahoo Finance fallback (unofficial) - raw endpoint, no yahoo-finance2 module enum
    try {
      const yahooUrl =
        "https://query2.finance.yahoo.com/v10/finance/quoteSummary/" +
        encodeURIComponent(ticker) +
        "?modules=financialData,defaultKeyStatistics,earningsTrend";

      const r2 = await fetch(yahooUrl, {
        headers: {
          // Yahoo is picky; this reduces 403/blocked responses sometimes.
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "application/json",
        },
        cache: "no-store",
      });

      const text2 = await r2.text().catch(() => "");
      if (!r2.ok) {
        return NextResponse.json(
          {
            ticker,
            analystGrowth: null,
            source: "yahoo_unofficial_raw",
            reason: `Yahoo returned ${r2.status}`,
            details: text2.slice(0, 300),
          },
          { status: 200 }
        );
      }

      const j2 = text2 ? JSON.parse(text2) : null;
      const res0 = j2?.quoteSummary?.result?.[0];

      // 1) Best case: financialData.earningsGrowth (already a growth rate)
      const egRaw = res0?.financialData?.earningsGrowth?.raw;
      const earningsGrowth =
        typeof egRaw === "number" && Number.isFinite(egRaw) ? egRaw : null;

      if (earningsGrowth !== null) {
        return NextResponse.json(
          {
            ticker,
            analystGrowth: earningsGrowth,
            source: "yahoo_unofficial_raw",
            field: "financialData.earningsGrowth",
            note: "Yahoo unofficial. This may not be the same as long-term analyst growth but is forecast-oriented.",
          },
          { status: 200 }
        );
      }

      // 2) Next best: try earningsTrend for +5y growth if present
      const trend: any[] = res0?.earningsTrend?.trend ?? [];
      const plus5 = trend.find((t) => t?.period === "+5y") ?? null;
      const trendGrowthRaw = plus5?.growth?.raw;
      const trendGrowth =
        typeof trendGrowthRaw === "number" && Number.isFinite(trendGrowthRaw)
          ? trendGrowthRaw
          : null;

      if (trendGrowth !== null) {
        return NextResponse.json(
          {
            ticker,
            analystGrowth: trendGrowth,
            source: "yahoo_unofficial_raw",
            field: "earningsTrend.trend[+5y].growth",
            note: "Yahoo unofficial. +5y only exists for some tickers.",
          },
          { status: 200 }
        );
      }

      // 3) Fallback proxy: forward EPS vs trailing EPS over 1 year (very rough)
      const trailingEps = res0?.defaultKeyStatistics?.trailingEps?.raw;
      const forwardEps = res0?.defaultKeyStatistics?.forwardEps?.raw;

      const tEps = typeof trailingEps === "number" ? trailingEps : null;
      const fEps = typeof forwardEps === "number" ? forwardEps : null;

      const proxy =
        tEps && fEps && tEps > 0 && fEps > 0 ? (fEps / tEps) - 1 : null;

      return NextResponse.json(
        {
          ticker,
          analystGrowth: proxy,
          source: "yahoo_unofficial_raw",
          field: proxy !== null ? "defaultKeyStatistics.forwardEps vs trailingEps (proxy)" : null,
          reason: proxy === null ? "No usable Yahoo growth fields found" : undefined,
          debugPeriods: trend.map((t) => t?.period).filter(Boolean),
        },
        { status: 200 }
      );
    } catch (e) {
      return NextResponse.json(
        {
          ticker,
          analystGrowth: null,
          source: "yahoo_unofficial_raw",
          reason: "Yahoo raw fallback failed",
          details: String(e),
        },
        { status: 200 }
      );
    }
}
