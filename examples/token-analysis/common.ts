import type { ProofBundle } from "../../src/index.js";

export interface TokenAnalysisRequirement {
  token?: string;
  coingeckoId?: string;
  vsCurrency?: string;
  days?: number;
  instruction?: string;
}

export interface MovingAverageSummary {
  sma20: number | null;
  sma50: number | null;
  ema12: number | null;
  ema26: number | null;
}

export interface MacdSummary {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  trend: "bullish" | "bearish" | "neutral";
}

export interface BollingerBandsSummary {
  upper: number | null;
  middle: number | null;
  lower: number | null;
  bandwidth: number | null;
  percentB: number | null;
}

export interface VolumeAnalysisSummary {
  latest: number | null;
  average20: number | null;
  average50: number | null;
  relative20: number | null;
  relative50: number | null;
  trend: "expanding" | "contracting" | "flat";
}

export interface SupportResistanceSummary {
  support: number[];
  resistance: number[];
}

export interface TechnicalIndicatorSnapshot {
  rsi14: number | null;
  macd: MacdSummary;
  bollinger: BollingerBandsSummary;
  movingAverages: MovingAverageSummary;
  volumeAnalysis: VolumeAnalysisSummary;
  supportResistance: SupportResistanceSummary;
  priceChange24hPct: number | null;
  priceChange7dPct: number | null;
  volatility30dPct: number | null;
  tradingSignal: "buy" | "sell" | "hold";
  signalConfidence: number;
}

export interface TokenAnalysisReport {
  summary: string;
  outlook: "bullish" | "bearish" | "neutral";
  recommendation: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string[];
  risks: string[];
  opportunities: string[];
  supportLevels: number[];
  resistanceLevels: number[];
  indicatorNotes: string[];
  modelUsed?: string;
  sourceHash?: string;
}

export interface ChartPoint {
  timestamp: number;
  price: number;
  volume: number | null;
}

export interface TokenAnalysisDeliverable {
  requestedToken: string;
  coingeckoId: string;
  vsCurrency: string;
  analysisWindowDays: number;
  market: {
    latestPrice: number;
    latestVolume: number | null;
    latestMarketCap: number | null;
    datapoints: number;
    chart: ChartPoint[];
  };
  indicators: TechnicalIndicatorSnapshot;
  llmAnalysis: TokenAnalysisReport;
  llmModel: string;
  proofBundle: ProofBundle;
  attestedEndpoints: {
    dataSource: string;
    llm: string;
  };
}

export function parseJsonObject<T extends object>(
  value: unknown,
): T | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as T
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value)
    ? value as T
    : null;
}

export function parseModelJsonObject<T extends object>(
  value: string,
): T {
  const normalized = value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model output is not a JSON object");
  }

  return parsed as T;
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number | null, decimals = 4): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
