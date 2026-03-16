import {
  clamp,
  round,
  type TechnicalIndicatorSnapshot,
} from "./common.js";

export type MarketSeriesPoint = [timestampMs: number, value: number];

function seriesValues(points: MarketSeriesPoint[]): number[] {
  return points.map(([, value]) => value);
}

function lastOf<T>(values: T[]): T | null {
  return values.length > 0 ? values[values.length - 1]! : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  if (avg == null) return null;
  const variance = values.reduce((sum, value) => {
    return sum + ((value - avg) ** 2);
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function tail(values: number[], count: number): number[] {
  return values.slice(Math.max(0, values.length - count));
}

function smaSeries(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => {
    const start = index - period + 1;
    if (start < 0) return null;
    const window = values.slice(start, index + 1);
    const avg = mean(window);
    return avg == null ? null : avg;
  });
}

function emaSeries(values: number[], period: number): Array<number | null> {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: Array<number | null> = [];
  let ema: number | null = null;

  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (index + 1 < period) {
      result.push(null);
      continue;
    }

    if (ema == null) {
      const seed = mean(values.slice(index + 1 - period, index + 1));
      ema = seed == null ? value : seed;
    } else {
      ema = ((value - ema) * multiplier) + ema;
    }

    result.push(ema);
  }

  return result;
}

function computeRsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const delta = values[index]! - values[index - 1]!;
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let index = period + 1; index < values.length; index++) {
    const delta = values[index]! - values[index - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeMacd(values: number[]) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macdLine = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    if (fastValue == null || slowValue == null) return null;
    return fastValue - slowValue;
  });

  const signalInput = macdLine.filter((value): value is number => value != null);
  const signalDense = emaSeries(signalInput, 9);
  const signalLine: Array<number | null> = [];
  let signalIndex = 0;

  for (const value of macdLine) {
    if (value == null) {
      signalLine.push(null);
      continue;
    }
    signalLine.push(signalDense[signalIndex] ?? null);
    signalIndex += 1;
  }

  const macd = lastOf(macdLine);
  const signal = lastOf(signalLine);
  const histogram = macd != null && signal != null ? macd - signal : null;

  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  if (macd != null && signal != null) {
    if (macd > signal && histogram != null && histogram >= 0) trend = "bullish";
    else if (macd < signal && histogram != null && histogram <= 0) trend = "bearish";
  }

  return {
    macd: round(macd),
    signal: round(signal),
    histogram: round(histogram),
    trend,
  };
}

function computeBollinger(values: number[]) {
  const middleSeries = smaSeries(values, 20);
  const middle = lastOf(middleSeries);
  const window = tail(values, 20);
  if (middle == null || window.length < 20) {
    return {
      upper: null,
      middle: null,
      lower: null,
      bandwidth: null,
      percentB: null,
    };
  }

  const deviation = sampleStdDev(window);
  if (deviation == null) {
    return {
      upper: null,
      middle: null,
      lower: null,
      bandwidth: null,
      percentB: null,
    };
  }

  const upper = middle + (2 * deviation);
  const lower = middle - (2 * deviation);
  const latest = values[values.length - 1]!;
  const bandwidth = middle !== 0 ? ((upper - lower) / middle) * 100 : null;
  const percentB = upper !== lower ? (latest - lower) / (upper - lower) : null;

  return {
    upper: round(upper),
    middle: round(middle),
    lower: round(lower),
    bandwidth: round(bandwidth),
    percentB: round(percentB),
  };
}

function computeVolumeAnalysis(values: number[]) {
  const latest = lastOf(values);
  const average20 = mean(tail(values, 20));
  const average50 = mean(tail(values, 50));
  const relative20 = latest != null && average20 ? latest / average20 : null;
  const relative50 = latest != null && average50 ? latest / average50 : null;

  let trend: "expanding" | "contracting" | "flat" = "flat";
  if (relative20 != null) {
    if (relative20 >= 1.2) trend = "expanding";
    else if (relative20 <= 0.8) trend = "contracting";
  }

  return {
    latest: round(latest),
    average20: round(average20),
    average50: round(average50),
    relative20: round(relative20),
    relative50: round(relative50),
    trend,
  };
}

function computeSupportResistance(values: number[]) {
  const recent = tail(values, Math.min(values.length, 30));
  if (recent.length < 5) {
    return { support: [], resistance: [] };
  }

  const sorted = [...recent].sort((a, b) => a - b);
  const support = [
    sorted[Math.floor(sorted.length * 0.15)]!,
    sorted[Math.floor(sorted.length * 0.3)]!,
  ]
    .map((value) => round(value, 2))
    .filter((value): value is number => value != null);

  const resistance = [
    sorted[Math.floor(sorted.length * 0.7)]!,
    sorted[Math.floor(sorted.length * 0.85)]!,
  ]
    .map((value) => round(value, 2))
    .filter((value): value is number => value != null);

  return { support, resistance };
}

function pctChange(values: number[], periods: number): number | null {
  if (values.length <= periods) return null;
  const latest = values[values.length - 1]!;
  const prior = values[values.length - 1 - periods]!;
  if (prior === 0) return null;
  return ((latest - prior) / prior) * 100;
}

function computeVolatility(values: number[]): number | null {
  if (values.length < 30) return null;
  const recent = tail(values, 30);
  const returns: number[] = [];
  for (let index = 1; index < recent.length; index++) {
    const prev = recent[index - 1]!;
    const curr = recent[index]!;
    if (prev !== 0) {
      returns.push((curr - prev) / prev);
    }
  }
  const deviation = sampleStdDev(returns);
  return deviation == null ? null : deviation * Math.sqrt(30) * 100;
}

function computeTradingSignal(params: {
  rsi14: number | null;
  macdTrend: "bullish" | "bearish" | "neutral";
  latestPrice: number | null;
  sma20: number | null;
  sma50: number | null;
  relativeVolume20: number | null;
}) {
  let score = 0;

  if (params.rsi14 != null) {
    if (params.rsi14 < 35) score += 1;
    if (params.rsi14 > 65) score -= 1;
  }

  if (params.macdTrend === "bullish") score += 1;
  if (params.macdTrend === "bearish") score -= 1;

  if (
    params.latestPrice != null &&
    params.sma20 != null &&
    params.sma50 != null
  ) {
    if (params.latestPrice > params.sma20 && params.sma20 >= params.sma50) score += 1;
    if (params.latestPrice < params.sma20 && params.sma20 <= params.sma50) score -= 1;
  }

  if (params.relativeVolume20 != null) {
    if (params.relativeVolume20 > 1.15) score += 0.5;
    if (params.relativeVolume20 < 0.85) score -= 0.5;
  }

  if (score >= 2) return { tradingSignal: "buy" as const, signalConfidence: clamp(55 + (score * 10), 0, 100) };
  if (score <= -2) return { tradingSignal: "sell" as const, signalConfidence: clamp(55 + (Math.abs(score) * 10), 0, 100) };
  return { tradingSignal: "hold" as const, signalConfidence: clamp(45 + (Math.abs(score) * 10), 0, 100) };
}

export function computeTechnicalIndicators(
  prices: MarketSeriesPoint[],
  totalVolumes: MarketSeriesPoint[],
): TechnicalIndicatorSnapshot {
  const priceValues = seriesValues(prices);
  const volumeValues = seriesValues(totalVolumes);

  const sma20 = lastOf(smaSeries(priceValues, 20));
  const sma50 = lastOf(smaSeries(priceValues, 50));
  const ema12 = lastOf(emaSeries(priceValues, 12));
  const ema26 = lastOf(emaSeries(priceValues, 26));
  const rsi14 = computeRsi(priceValues, 14);
  const macd = computeMacd(priceValues);
  const bollinger = computeBollinger(priceValues);
  const volumeAnalysis = computeVolumeAnalysis(volumeValues);
  const supportResistance = computeSupportResistance(priceValues);
  const latestPrice = lastOf(priceValues);

  const signal = computeTradingSignal({
    rsi14,
    macdTrend: macd.trend,
    latestPrice,
    sma20,
    sma50,
    relativeVolume20: volumeAnalysis.relative20,
  });

  return {
    rsi14: round(rsi14),
    macd,
    bollinger,
    movingAverages: {
      sma20: round(sma20),
      sma50: round(sma50),
      ema12: round(ema12),
      ema26: round(ema26),
    },
    volumeAnalysis,
    supportResistance,
    priceChange24hPct: round(pctChange(priceValues, 1)),
    priceChange7dPct: round(pctChange(priceValues, 7)),
    volatility30dPct: round(computeVolatility(priceValues)),
    tradingSignal: signal.tradingSignal,
    signalConfidence: Math.round(signal.signalConfidence),
  };
}
