import {
  StepConfig,
  StepResult,
  ProofBundle,
  ProofChainBuilderConfig,
  TrustLayerError,
  TrustLayerErrorCode,
} from "../types/index.js";
import { computeChainHash } from "../utils/hash.js";
import { StepProver } from "./StepProver.js";

/**
 * ProofChainBuilder
 *
 * The main entry point for TrustLayer. Providers use this class to:
 *  1. Register ordered proof steps (data source fetches, LLM calls)
 *  2. Execute them in sequence with chain linkage enforcement
 *  3. Build a ProofBundle to include in the ACP Deliverable Memo
 *
 * Example:
 *
 *   const builder = new ProofChainBuilder({
 *     primusAppId: "...",
 *     primusAppSecret: "...",
 *     providerWallet: "0x...",
 *   });
 *
 *   await builder.addStep({ stepId: "data_source", url: "https://reuters.com/...", ... });
 *   await builder.addStep({ stepId: "llm_inference", url: "https://api.openai.com/...",
 *                           dependsOn: "data_source", ... });
 *
 *   const bundle = await builder.build();
 *   await job.deliver(JSON.stringify({ verdict: "...", proofBundle: bundle }));
 */
export class ProofChainBuilder {
  private primus: any;
  private prover!: StepProver;
  private stepConfigs: StepConfig[] = [];
  private stepResults: Record<string, StepResult> = {};
  private initialized = false;
  private readonly config: Required<ProofChainBuilderConfig>;

  constructor(config: ProofChainBuilderConfig) {
    this.config = {
      maxAttestationAge: 600_000, // 10 minutes default
      ...config,
    };
  }

  /** Lazy-initialize the Primus SDK */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Dynamic import — @primuslabs/network-core-sdk is CommonJS
    const { PrimusNetwork } = await import("@primuslabs/network-core-sdk");
    this.primus = new PrimusNetwork();
    await this.primus.init(
      this.config.primusAppId,
      this.config.primusAppSecret,
    );
    this.prover = new StepProver(this.primus);
    this.initialized = true;
  }

  /**
   * Register and immediately execute a proof step.
   * Steps are executed in the order they are added.
   * Returns the StepResult so callers can use extracted data
   * (e.g. to build the next step's body).
   */
  async addStep(config: StepConfig): Promise<StepResult> {
    await this.ensureInitialized();

    // Validate dependency ordering
    if (config.dependsOn) {
      if (!this.stepResults[config.dependsOn.stepId]) {
        throw new TrustLayerError(
          `Step "${config.stepId}" depends on "${config.dependsOn.stepId}" which hasn't been added yet`,
          TrustLayerErrorCode.STEP_NOT_FOUND,
          config.stepId,
        );
      }
    }

    // Execute the step
    const result = await this.prover.prove(
      config,
      this.stepResults,
      this.config.providerWallet,
    );

    this.stepConfigs.push(config);
    this.stepResults[config.stepId] = result;

    return result;
  }

  /**
   * Get the result of a previously executed step.
   * Useful for reading extracted data mid-chain.
   */
  getStepResult(stepId: string): StepResult {
    const result = this.stepResults[stepId];
    if (!result) {
      throw new TrustLayerError(
        `Step "${stepId}" has not been executed`,
        TrustLayerErrorCode.STEP_NOT_FOUND,
      );
    }
    return result;
  }

  /**
   * Build the final ProofBundle.
   * This is what gets embedded in the ACP Deliverable Memo
   * and submitted to the on-chain verifier.
   */
  async build(): Promise<ProofBundle> {
    if (this.stepConfigs.length === 0) {
      throw new TrustLayerError(
        "Cannot build an empty ProofBundle — add at least one step",
        TrustLayerErrorCode.ATTESTATION_INVALID,
      );
    }

    const steps = this.stepConfigs.map((config) => ({
      stepId: config.stepId,
      attestation: this.stepResults[config.stepId].attestation,
    }));

    const taskIds = steps.map((s) => s.attestation.taskId);
    const chainHash = computeChainHash(taskIds);

    return {
      version: "1.0",
      providerWallet: this.config.providerWallet,
      steps,
      chainHash,
      builtAt: Date.now(),
    };
  }

  /** Reset the builder for reuse */
  reset(): void {
    this.stepConfigs = [];
    this.stepResults = {};
  }
}
