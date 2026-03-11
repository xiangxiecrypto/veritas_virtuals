import { describe, expect, it } from "@jest/globals";

/**
 * Tests for OnChainSubmitter's HOOK_ABI consistency with the
 * IEvaluatorPolicy-based TrustLayerACPHook contract.
 *
 * These are structural tests that verify ABI fragments and method
 * existence without requiring a live Ethereum connection.
 */
describe("OnChainSubmitter — ABI and method consistency", () => {
  it("exports the expected policy management methods", async () => {
    const mod = await import("../src/chain/OnChainSubmitter.js");
    const submitterProto = mod.OnChainSubmitter.prototype;

    expect(typeof submitterProto.setPolicy).toBe("function");
    expect(typeof submitterProto.removePolicy).toBe("function");
    expect(typeof submitterProto.getPolicyAddress).toBe("function");
    expect(typeof submitterProto.registerProvider).toBe("function");
    expect(typeof submitterProto.submitBundle).toBe("function");
    expect(typeof submitterProto.verifyBundle).toBe("function");
    expect(typeof submitterProto.isVerified).toBe("function");
  });

  it("does NOT export removed methods from the old parameter-based policy model", async () => {
    const mod = await import("../src/chain/OnChainSubmitter.js");
    const submitterProto = mod.OnChainSubmitter.prototype;

    expect((submitterProto as any).registerPolicy).toBeUndefined();
    expect((submitterProto as any).deactivatePolicy).toBeUndefined();
    expect((submitterProto as any).getPolicy).toBeUndefined();
  });

  it("CONTRACT_ADDRESSES includes expected networks", async () => {
    const { CONTRACT_ADDRESSES } = await import("../src/chain/OnChainSubmitter.js");
    expect(CONTRACT_ADDRESSES).toHaveProperty("base_mainnet");
    expect(CONTRACT_ADDRESSES).toHaveProperty("base_sepolia");
  });
});

describe("SDK public exports — policy types", () => {
  it("does NOT export EvaluatorPolicyConfig (removed type)", async () => {
    const mod = await import("../src/index.js");
    expect((mod as any).EvaluatorPolicyConfig).toBeUndefined();
  });

  it("exports OnChainSubmitter with setPolicy/removePolicy", async () => {
    const { OnChainSubmitter } = await import("../src/index.js");
    expect(typeof OnChainSubmitter.prototype.setPolicy).toBe("function");
    expect(typeof OnChainSubmitter.prototype.removePolicy).toBe("function");
    expect(typeof OnChainSubmitter.prototype.getPolicyAddress).toBe("function");
  });
});

describe("SDK public exports — domain utils", () => {
  it("does NOT export TRUSTED_DOMAINS (removed global whitelist)", async () => {
    const mod = await import("../src/index.js");
    expect((mod as any).TRUSTED_DOMAINS).toBeUndefined();
  });

  it("exports extractDomain and isTrustedDomain as utilities", async () => {
    const { extractDomain, isTrustedDomain } = await import("../src/index.js");
    expect(typeof extractDomain).toBe("function");
    expect(typeof isTrustedDomain).toBe("function");
  });

  it("isTrustedDomain allows all when no whitelist given", async () => {
    const { isTrustedDomain } = await import("../src/index.js");
    expect(isTrustedDomain("https://any-random-domain.com/api")).toBe(true);
  });

  it("isTrustedDomain checks against provided whitelist", async () => {
    const { isTrustedDomain } = await import("../src/index.js");
    const whitelist = new Set(["api.example.com"]);
    expect(isTrustedDomain("https://api.example.com/v1", whitelist)).toBe(true);
    expect(isTrustedDomain("https://evil.com/v1", whitelist)).toBe(false);
  });
});
