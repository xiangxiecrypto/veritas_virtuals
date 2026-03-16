import {
  ProofChainBuilder,
  buildHashReference,
} from "../../src/index.js";
import {
  asFiniteNumber,
  clamp,
  parseJsonObject,
  parseModelJsonObject,
  type TokenAnalysisDeliverable,
  type TokenAnalysisReport,
  type TokenAnalysisRequirement,
} from "./common.js";
import {
  buildChartPreview,
  parseMarketChartStep,
  resolveCoinGeckoAsset,
} from "./coingecko.js";
import { computeTechnicalIndicators } from "./indicators.js";

const PRIMUS_APP_ID = process.env.PRIMUS_APP_ID!;
const PRIMUS_APP_SECRET = process.env.PRIMUS_APP_SECRET!;
const PROVIDER_WALLET = process.env.AGENT_WALLET_ADDRESS!;
const ZAI_API_KEY = process.env.ZAI_API_KEY!;
const ZAI_MODEL = process.env.ZAI_MODEL ?? "glm-5";
const DEFAULT_VS_CURRENCY = process.env.COINGECKO_VS_CURRENCY ?? "usd";
const DEFAULT_ANALYSIS_DAYS = Number(process.env.TOKEN_ANALYSIS_DEFAULT_DAYS ?? "90");

interface ModelAnalysisShape {
  summary?: string;
  outlook?: "bullish" | "bearish" | "neutral";
  recommendation?: "buy" | "sell" | "hold";
  confidence?: number | string;
  reasoning?: string[];
  risks?: string[];
  opportunities?: string[];
  support_levels?: Array<number | string>;
  resistance_levels?: Array<number | string>;
  indicator_notes?: string[];
}

function normalizeNumberArray(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => asFiniteNumber(value))
    .filter((value): value is number => value != null);
}

function normalizeReport(
  raw: ModelAnalysisShape,
  fallback: ReturnType<typeof computeTechnicalIndicators>,
  modelUsed: string,
  sourceHash: string,
): TokenAnalysisReport {
  const confidence = clamp(
    Math.round(asFiniteNumber(raw.confidence) ?? fallback.signalConfidence),
    0,
    100,
  );

  return {
    summary: raw.summary ?? "No summary returned by model.",
    outlook: raw.outlook ?? "neutral",
    recommendation: raw.recommendation ?? fallback.tradingSignal,
    confidence,
    reasoning: Array.isArray(raw.reasoning) ? raw.reasoning : [],
    risks: Array.isArray(raw.risks) ? raw.risks : [],
    opportunities: Array.isArray(raw.opportunities) ? raw.opportunities : [],
    supportLevels: normalizeNumberArray(raw.support_levels).length > 0
      ? normalizeNumberArray(raw.support_levels)
      : fallback.supportResistance.support,
    resistanceLevels: normalizeNumberArray(raw.resistance_levels).length > 0
      ? normalizeNumberArray(raw.resistance_levels)
      : fallback.supportResistance.resistance,
    indicatorNotes: Array.isArray(raw.indicator_notes) ? raw.indicator_notes : [],
    modelUsed,
    sourceHash,
  };
}

export async function buildTokenAnalysisDeliverable(
  requirement: TokenAnalysisRequirement,
): Promise<TokenAnalysisDeliverable> {
  const requestedToken = requirement.token ?? requirement.coingeckoId;
  if (!requestedToken) {
    throw new Error("Token analysis requires `token` or `coingeckoId`");
  }

  const { coingeckoId } = resolveCoinGeckoAsset(
    requestedToken,
    requirement.coingeckoId,
  );
  const vsCurrency = (requirement.vsCurrency ?? DEFAULT_VS_CURRENCY).toLowerCase();
  const analysisWindowDays = Math.max(30, Math.min(365, requirement.days ?? DEFAULT_ANALYSIS_DAYS));

  const builder = new ProofChainBuilder({
    primusAppId: PRIMUS_APP_ID,
    primusAppSecret: PRIMUS_APP_SECRET,
    providerWallet: PROVIDER_WALLET,
    trustedDomains: ["api.coingecko.com", "api.z.ai"],
  });

  const dataSourceResult = await builder.addStep({
    stepId: "data_source",
    url: [
      "https://api.coingecko.com/api/v3/coins",
      encodeURIComponent(coingeckoId),
      `market_chart?vs_currency=${encodeURIComponent(vsCurrency)}&days=${analysisWindowDays}`,
    ].join("/"),
    method: "GET",
    headers: {
      "User-Agent": "Veritas-TokenAnalysis/1.0",
      "Accept": "application/json",
    },
    responseResolves: [
      { keyName: "prices", parseType: "json", parsePath: "$.prices" },
      { keyName: "total_volumes", parseType: "json", parsePath: "$.total_volumes" },
      { keyName: "market_caps", parseType: "json", parsePath: "$.market_caps" },
    ],
  });

  const parsedMarket = parseMarketChartStep(dataSourceResult.data);
  if (parsedMarket.prices.length < 30) {
    throw new Error("CoinGecko market chart returned too few price points");
  }

  const indicators = computeTechnicalIndicators(
    parsedMarket.prices,
    parsedMarket.totalVolumes,
  );
  const chartPreview = buildChartPreview(
    parsedMarket.prices,
    parsedMarket.totalVolumes,
    30,
  );
  const latestPrice = parsedMarket.prices[parsedMarket.prices.length - 1]?.[1];
  const latestVolume = parsedMarket.totalVolumes[parsedMarket.totalVolumes.length - 1]?.[1] ?? null;
  const latestMarketCap = parsedMarket.marketCaps[parsedMarket.marketCaps.length - 1]?.[1] ?? null;

  if (latestPrice == null) {
    throw new Error("CoinGecko market chart did not include a latest price");
  }

  const llmSourceHash = buildHashReference(
    "data_source",
    dataSourceResult.attestation.attestation.data,
  );

  const llmResult = await builder.addStep({
    stepId: "llm_inference",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ZAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    bodyBuilder: () => JSON.stringify({
      model: ZAI_MODEL,
      temperature: 0.1,
      seed: 42,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a crypto market analyst.",
            "Return valid JSON only.",
            "Schema:",
            JSON.stringify({
              summary: "string",
              outlook: "bullish|bearish|neutral",
              recommendation: "buy|sell|hold",
              confidence: "0-100",
              reasoning: ["string"],
              risks: ["string"],
              opportunities: ["string"],
              support_levels: [0],
              resistance_levels: [0],
              indicator_notes: ["string"],
            }),
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            llmSourceHash,
            "",
            `Analyze token: ${requestedToken} (CoinGecko id: ${coingeckoId})`,
            `Quoted in: ${vsCurrency.toUpperCase()}`,
            `Window: ${analysisWindowDays} days`,
            requirement.instruction ? `User instruction: ${requirement.instruction}` : "",
            "",
            "Use this attested market data and locally-computed indicators:",
            JSON.stringify({
              latestPrice,
              latestVolume,
              latestMarketCap,
              datapoints: parsedMarket.prices.length,
              indicators,
              chartPreview,
            }),
            "",
            "Focus on RSI, MACD, Bollinger Bands, moving averages, volume, support/resistance, and actionable trading stance.",
          ].filter(Boolean).join("\n"),
        },
      ],
    }),
    responseResolves: [
      {
        keyName: "analysis_json",
        parseType: "json",
        parsePath: "$.choices[0].message.content",
      },
      {
        keyName: "model_used",
        parseType: "json",
        parsePath: "$.model",
      },
    ],
    dependsOn: {
      stepId: "data_source",
      sourceField: "prices",
    },
  });

  const rawModelOutput = llmResult.data["analysis_json"] ?? "{}";
  const parsedModelOutput = parseModelJsonObject<ModelAnalysisShape>(rawModelOutput);
  const llmModel = llmResult.data["model_used"] ?? ZAI_MODEL;
  const llmAnalysis = normalizeReport(parsedModelOutput, indicators, llmModel, llmSourceHash);
  const proofBundle = await builder.build();

  return {
    requestedToken,
    coingeckoId,
    vsCurrency,
    analysisWindowDays,
    market: {
      latestPrice,
      latestVolume,
      latestMarketCap,
      datapoints: parsedMarket.prices.length,
      chart: chartPreview,
    },
    indicators,
    llmAnalysis,
    llmModel,
    proofBundle,
    attestedEndpoints: {
      dataSource: dataSourceResult.attestation.attestation.request.url,
      llm: llmResult.attestation.attestation.request.url,
    },
  };
}

export async function executeTokenAnalysis(job: any): Promise<void> {
  const requirement = parseJsonObject<TokenAnalysisRequirement>(job.requirement);
  if (!requirement) {
    throw new Error("Token analysis job requirement must be a JSON object");
  }

  const deliverable = await buildTokenAnalysisDeliverable(requirement);
  await job.deliver(JSON.stringify(deliverable));
}
