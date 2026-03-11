import { describe, expect, it, jest } from "@jest/globals";
import { StepProver } from "../src/core/StepProver.js";
import type { StepConfig, StepResult } from "../src/types/index.js";
import { buildHashReference } from "../src/utils/hash.js";

const providerWallet = "0x1234567890123456789012345678901234567890";

function makeAttestationResult(data: string) {
  return {
    attestation: {
      recipient: providerWallet,
      request: { url: "", header: "{}", method: "GET", body: "" },
      responseResolve: [],
      data,
      attConditions: "{}",
      timestamp: Date.now(),
      additionParams: "{}",
    },
    attestor: "0xattestor",
    signature: "0xsig",
    reportTxHash: "0xreport",
    taskId: "task-1",
    attestationTime: 1,
    attestorUrl: "https://verifier.example.com",
  };
}

describe("StepProver", () => {
  it("defaults to proxytls when mode is omitted", async () => {
    const setAttMode = jest.fn();
    const generateRequestParams = jest.fn(() => ({ setAttMode }));
    const startAttestation = jest.fn(async () =>
      makeAttestationResult(JSON.stringify({ price: "100" })),
    );
    const verifyAttestation = jest.fn(() => true);

    const prover = new StepProver(
      {
        generateRequestParams,
        startAttestation,
        verifyAttestation,
      },
      { trustedDomains: ["api.marketdata.example.com"] },
    );

    const config: StepConfig = {
      stepId: "source_data",
      url: "https://api.marketdata.example.com/v1/price",
      method: "GET",
      headers: {},
      responseResolves: [
        { keyName: "price", parseType: "json", parsePath: "$.price" },
      ],
    };

    await prover.prove(config, {}, providerWallet);

    expect(generateRequestParams).toHaveBeenCalled();
    expect(setAttMode).toHaveBeenCalledWith({ algorithmType: "proxytls" });
    expect(startAttestation).toHaveBeenCalled();
    expect(verifyAttestation).toHaveBeenCalled();
  });

  it("rejects a downstream step when hash linkage is missing", async () => {
    const prover = new StepProver(
      {
        generateRequestParams: jest.fn(),
        startAttestation: jest.fn(),
        verifyAttestation: jest.fn(),
      },
      { trustedDomains: ["api.service.example.com"] },
    );

    const sourceRawData = JSON.stringify({ price: "100" });
    const prevSteps: Record<string, StepResult> = {
      source_data: {
        stepId: "source_data",
        data: { price: "100" },
        dataHash: "ignored",
        attestation: makeAttestationResult(sourceRawData),
        executedAt: Date.now(),
      },
    };

    const badConfig: StepConfig = {
      stepId: "risk_score",
      url: "https://api.service.example.com/v1/score",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evidence: "missing-hash" }),
      responseResolves: [
        { keyName: "score", parseType: "json", parsePath: "$.score" },
      ],
      dependsOn: {
        stepId: "source_data",
        sourceField: "price",
      },
    };

    await expect(prover.prove(badConfig, prevSteps, providerWallet)).rejects.toThrow(
      "Chain linkage broken",
    );
  });

  it("allows any domain when no trustedDomains is provided", async () => {
    const setAttMode = jest.fn();
    const prover = new StepProver(
      {
        generateRequestParams: jest.fn(() => ({ setAttMode })),
        startAttestation: jest.fn(async () =>
          makeAttestationResult(JSON.stringify({ value: "42" })),
        ),
        verifyAttestation: jest.fn(() => true),
      },
      // no trustedDomains → allow all
    );

    const config: StepConfig = {
      stepId: "any_api",
      url: "https://api.custom-unknown-service.com/v1/data",
      method: "GET",
      headers: {},
      responseResolves: [
        { keyName: "value", parseType: "json", parsePath: "$.value" },
      ],
    };

    const result = await prover.prove(config, {}, providerWallet);
    expect(result.data.value).toBe("42");
  });

  it("accepts a downstream step when the upstream hash is present", async () => {
    const setAttMode = jest.fn();
    const prover = new StepProver(
      {
        generateRequestParams: jest.fn(() => ({ setAttMode })),
        startAttestation: jest.fn(async () =>
          makeAttestationResult(JSON.stringify({ score: "77" })),
        ),
        verifyAttestation: jest.fn(() => true),
      },
      { trustedDomains: ["api.service.example.com"] },
    );

    const price = "100";
    const sourceRawData = JSON.stringify({ price });
    const prevSteps: Record<string, StepResult> = {
      source_data: {
        stepId: "source_data",
        data: { price },
        dataHash: "ignored",
        attestation: makeAttestationResult(sourceRawData),
        executedAt: Date.now(),
      },
    };

    const goodConfig: StepConfig = {
      stepId: "risk_score",
      url: "https://api.service.example.com/v1/score",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        evidence: buildHashReference("source_data", sourceRawData),
      }),
      responseResolves: [
        { keyName: "score", parseType: "json", parsePath: "$.score" },
      ],
      dependsOn: {
        stepId: "source_data",
        sourceField: "price",
      },
    };

    const result = await prover.prove(goodConfig, prevSteps, providerWallet);

    expect(result.data.score).toBe("77");
    expect(setAttMode).toHaveBeenCalledWith({ algorithmType: "proxytls" });
  });
});

