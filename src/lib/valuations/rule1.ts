export type SeriesPoint = { end: string; val: number };

export type GrowthBasis =
  | "bvps_5y"
  | "bvps_10y"
  | "fcf_5y"
  | "fcf_10y"
  | "eps_5y"
  | "eps_10y";

export function growthBasisLabel(b: GrowthBasis): string {
  switch (b) {
    case "bvps_5y":
      return "BVPS last 5 years";
    case "bvps_10y":
      return "BVPS last 10 years";
    case "fcf_5y":
      return "Free Cash Flow last 5 years";
    case "fcf_10y":
      return "Free Cash Flow last 10 years";
    case "eps_5y":
      return "EPS last 5 years";
    case "eps_10y":
      return "EPS last 10 years";
  }
}

export type Rule1Inputs = {
  eps: SeriesPoint[];                   // split-adjusted (per share)
  bookValuePerShareUSD: SeriesPoint[];  // split-adjusted (per share)
  freeCashFlowUSD: SeriesPoint[];       // total $ (not per share)
  historicPeRatio: number | null;
  latestPriceUSD: number | null;
};

export type Rule1Knobs = {
  years: number;                 // years into the future (your formula)
  analystGrowth: number;         // decimal, e.g. 0.12
  desiredReturn: number;         // decimal, e.g. 0.15
  marginOfSafetyPercent: number; // percent, e.g. 50
  growthBasis: GrowthBasis;
};

export type Rule1Failure = {
  error: {
    type: "GROWTH_BASIS_UNAVAILABLE";
    message: string;
    growthBasis: GrowthBasis;
    pointsNeeded: number;
    pointsAvailable: number;
  };
};

export type Rule1Result = {
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

export type Rule1ResultOrFailure = Rule1Result | Rule1Failure;

function yearOf(end: string): number {
  return Number(end.slice(0, 4));
}

function cagr(start: number, end: number, years: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || years <= 0) return 0;
  if (start <= 0 || end <= 0) return 0;
  return Math.pow(end / start, 1 / years) - 1;
}

function normalizeSeries(series: SeriesPoint[]): SeriesPoint[] {
  return series
    .filter((p) => p && Number.isFinite(p.val) && typeof p.end === "string")
    .slice()
    .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

// Option A: "last N annual points".
// If points=10, we use start = 10th-from-last, end = last.
function computeGrowthByPoints(
  series: SeriesPoint[],
  points: number
): { start: SeriesPoint; end: SeriesPoint; yearsActual: number; growth: number } | null {
  const s = normalizeSeries(series);
  if (s.length < points) return null;

  const end = s[s.length - 1];
  const start = s[s.length - points];

  const yearsActual = Math.max(1, yearOf(end.end) - yearOf(start.end));
  const growth = cagr(start.val, end.val, yearsActual);

  return { start, end, yearsActual, growth };
}

// Mapping for Option A
// 5y = last 6 points (~5-year span)
// 10y = last 10 points (~9-year span for AAPL currently, but works and yearsActual is shown)
function pointsNeededForBasis(b: GrowthBasis): number {
  switch (b) {
    case "bvps_5y":
    case "fcf_5y":
    case "eps_5y":
      return 6;
    case "bvps_10y":
    case "fcf_10y":
    case "eps_10y":
      return 10;
  }
}

export function calculateRule1(inputs: Rule1Inputs, knobs: Rule1Knobs): Rule1ResultOrFailure | null {
  const epsSeries = normalizeSeries(inputs.eps);
  if (epsSeries.length === 0) return null;

  const latestEps = epsSeries[epsSeries.length - 1].val;

  const pe = inputs.historicPeRatio;
  if (pe === null || !Number.isFinite(pe) || pe <= 0) return null;

  const basisKey = knobs.growthBasis;
  const basisLabel = growthBasisLabel(basisKey);

  let basisSeries: SeriesPoint[];
  if (basisKey === "bvps_5y" || basisKey === "bvps_10y") {
    basisSeries = inputs.bookValuePerShareUSD;
  } else if (basisKey === "fcf_5y" || basisKey === "fcf_10y") {
    basisSeries = inputs.freeCashFlowUSD;
  } else {
    basisSeries = inputs.eps;
  }

  const pointsNeeded = pointsNeededForBasis(basisKey);
  const normalized = normalizeSeries(basisSeries);
  const pointsAvailable = normalized.length;

  const g = computeGrowthByPoints(normalized, pointsNeeded);
  if (!g) {
    return {
      error: {
        type: "GROWTH_BASIS_UNAVAILABLE",
        message: `Not enough data to compute ${basisLabel} (need ${pointsNeeded} annual points, have ${pointsAvailable})`,
        growthBasis: basisKey,
        pointsNeeded,
        pointsAvailable,
      },
    };
  }

  const basisGrowth = g.growth;
  const chosenGrowth = Math.min(knobs.analystGrowth, basisGrowth);

  // Your formula:
  // valuation = latest EPS × historic PE × (1 + minGrowth)^years
  const futureValue = latestEps * pe * Math.pow(1 + chosenGrowth, knobs.years);

  // sticker = valuation / (1 + desiredReturn)^years
  const stickerPrice = futureValue / Math.pow(1 + knobs.desiredReturn, knobs.years);

  // MOS price = sticker × (100 - MOS)%
  const mosFactor = Math.max(0, Math.min(1, (100 - knobs.marginOfSafetyPercent) / 100));
  const stickerPriceWithMOS = stickerPrice * mosFactor;

  return {
    latestEps,
    basis: {
      key: basisKey,
      label: basisLabel,
      pointsUsed: pointsNeeded,
      yearsActual: g.yearsActual,
      startEnd: g.start.end,
      endEnd: g.end.end,
      startVal: g.start.val,
      endVal: g.end.val,
      growth: basisGrowth,
    },
    chosenGrowth,
    historicPeUsed: pe,
    futureValue,
    stickerPrice,
    stickerPriceWithMOS,
    currentPrice: inputs.latestPriceUSD,
  };
}
