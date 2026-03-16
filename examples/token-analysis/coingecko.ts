import type { ChartPoint } from "./common.js";
import type { MarketSeriesPoint } from "./indicators.js";

const COMMON_ASSET_IDS: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  bnb: "binancecoin",
  binancecoin: "binancecoin",
  xrp: "ripple",
  ripple: "ripple",
  ada: "cardano",
  cardano: "cardano",
  doge: "dogecoin",
  dogecoin: "dogecoin",
  avax: "avalanche-2",
  avalanche: "avalanche-2",
  link: "chainlink",
  chainlink: "chainlink",
  dot: "polkadot",
  polkadot: "polkadot",
};

export interface ResolvedCoinGeckoAsset {
  requestedToken: string;
  coingeckoId: string;
}

export interface ParsedMarketChart {
  prices: MarketSeriesPoint[];
  totalVolumes: MarketSeriesPoint[];
  marketCaps: MarketSeriesPoint[];
}

export function resolveCoinGeckoAsset(input: string, explicitId?: string): ResolvedCoinGeckoAsset {
  const requestedToken = input.trim();
  if (!requestedToken) {
    throw new Error("Token symbol or CoinGecko id is required");
  }

  if (explicitId && explicitId.trim()) {
    return { requestedToken, coingeckoId: explicitId.trim().toLowerCase() };
  }

  const normalized = requestedToken.trim().toLowerCase();
  const mapped = COMMON_ASSET_IDS[normalized];
  if (mapped) {
    return { requestedToken, coingeckoId: mapped };
  }

  return {
    requestedToken,
    coingeckoId: normalized.replace(/[\s_]+/g, "-"),
  };
}

function parsePoint(raw: unknown): MarketSeriesPoint | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const timestamp = Number(raw[0]);
  const value = Number(raw[1]);
  if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return null;
  return [timestamp, value];
}

function parseSeries(raw: string): MarketSeriesPoint[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected attested market chart series to be an array");
  }

  return parsed
    .map((entry) => parsePoint(entry))
    .filter((entry): entry is MarketSeriesPoint => entry != null);
}

export function parseMarketChartStep(stepData: Record<string, string>): ParsedMarketChart {
  return {
    prices: parseSeries(stepData["prices"] ?? "[]"),
    totalVolumes: parseSeries(stepData["total_volumes"] ?? "[]"),
    marketCaps: parseSeries(stepData["market_caps"] ?? "[]"),
  };
}

export function buildChartPreview(
  prices: MarketSeriesPoint[],
  totalVolumes: MarketSeriesPoint[],
  limit = 30,
): ChartPoint[] {
  const priceTail = prices.slice(Math.max(0, prices.length - limit));
  const volumeMap = new Map(totalVolumes.map(([timestamp, value]) => [timestamp, value]));

  return priceTail.map(([timestamp, price]) => ({
    timestamp,
    price,
    volume: volumeMap.get(timestamp) ?? null,
  }));
}
