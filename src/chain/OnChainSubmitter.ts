import { ethers } from "ethers";
import { ProofBundle, OnChainVerificationResult } from "../types/index.js";

// ── ABI fragments matching the official Primus Attestation struct ──
//
// On-chain Attestation layout (from IPrimusZKTLS.sol):
//   struct Attestation {
//     address recipient;
//     AttNetworkRequest request;              // single request
//     AttNetworkResponseResolve[] reponseResolve;  // note: official typo "reponse"
//     string data;
//     string attConditions;
//     uint64 timestamp;
//     string additionParams;
//     Attestor[] attestors;
//     bytes[] signatures;
//   }
//
// On-chain ProofStep layout (from ITrustLayer.sol):
//   struct ProofStep {
//     string stepId;
//     string primusTaskId;
//     Attestation attestation;
//   }

const ATTESTATION_TUPLE =
  "tuple(" +
    "address recipient, " +
    "tuple(string url, string header, string method, string body) request, " +
    "tuple(string keyName, string parseType, string parsePath)[] reponseResolve, " +
    "string data, " +
    "string attConditions, " +
    "uint64 timestamp, " +
    "string additionParams, " +
    "tuple(address attestorAddr, string url)[] attestors, " +
    "bytes[] signatures" +
  ")";

const PROOF_STEP_TUPLE =
  `tuple(string stepId, string primusTaskId, ${ATTESTATION_TUPLE} attestation)`;

const PROOF_BUNDLE_TUPLE =
  `tuple(${PROOF_STEP_TUPLE}[] steps, bytes32 chainHash, address providerWallet, uint256 builtAt)`;

const VERIFIER_ABI = [
  `function verifyProofBundle(${PROOF_BUNDLE_TUPLE} bundle, address providerAddress) view returns (bool)`,
  "event TrustLayerVerified(address indexed provider, bytes32 indexed chainHash, uint256 stepCount, uint256 verifiedAt)",
];

const HOOK_ABI = [
  "function registerProvider() external",
  "function deregisterProvider() external",
  "function setPolicy(address policyContract) external",
  "function removePolicy() external",
  "function evaluatorPolicies(address evaluator) view returns (address)",
  "function verifyDeliverable(uint256 jobId, address providerAddress, address evaluatorAddress, bytes calldata encodedBundle) external returns (bool)",
  "function isProviderVerified(address provider, bytes32 chainHash) external view returns (bool)",
];

export const CONTRACT_ADDRESSES = {
  base_mainnet: {
    TrustLayerVerifier: "",
    TrustLayerACPHook: "",
    PrimusZKTLS: "",
  },
  base_sepolia: {
    TrustLayerVerifier: "",
    TrustLayerACPHook: "",
    PrimusZKTLS: "",
  },
} as const;

export type Network = keyof typeof CONTRACT_ADDRESSES;
export interface ContractAddressOverrides {
  TrustLayerVerifier?: string;
  TrustLayerACPHook?: string;
  PrimusZKTLS?: string;
}

export class OnChainSubmitter {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private verifierAddress?: string;
  private hookAddress?: string;

  constructor(
    privateKey: string,
    network: Network = "base_mainnet",
    rpcUrl?: string,
    overrides?: ContractAddressOverrides,
  ) {
    const rpc = rpcUrl ?? (network === "base_mainnet"
      ? "https://mainnet.base.org"
      : "https://sepolia.base.org");

    this.provider = new ethers.JsonRpcProvider(rpc);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    const addresses = { ...CONTRACT_ADDRESSES[network], ...overrides };
    this.verifierAddress = addresses.TrustLayerVerifier || undefined;
    this.hookAddress = addresses.TrustLayerACPHook || undefined;
  }

  /**
   * Dry-run verify a ProofBundle using eth_call (no gas).
   */
  async verifyBundle(
    bundle: ProofBundle,
    providerAddress: string,
  ): Promise<OnChainVerificationResult> {
    try {
      const verifier = this.getVerifierContract();
      const result: boolean = await verifier.verifyProofBundle(
        this.encodeBundle(bundle),
        providerAddress,
      );
      return { verified: result };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  /**
   * Submit the ProofBundle to the ACP hook contract (gas required).
   * The hook will verify proof authenticity AND enforce the evaluator's
   * on-chain policy in a single automated transaction.
   */
  async submitBundle(
    jobId: number | bigint,
    bundle: ProofBundle,
    providerAddress: string,
    evaluatorAddress: string,
  ): Promise<OnChainVerificationResult> {
    try {
      const hook = this.getHookContract();
      const encoded = this.encodeBundleForHook(bundle);
      const tx = await hook.verifyDeliverable(
        jobId,
        providerAddress,
        evaluatorAddress,
        encoded,
      );
      const receipt = await tx.wait();
      return { verified: true, txHash: receipt.hash };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  // ── Provider / Evaluator Management ─────────────────────

  /**
   * Register the caller as a TrustLayer-enabled provider on the hook.
   */
  async registerProvider(): Promise<string> {
    const hook = this.getHookContract();
    const tx = await hook.registerProvider();
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Point the caller's evaluator slot to a deployed IEvaluatorPolicy contract.
   * After this, verifyDeliverable automatically calls policy.check() — fully automated.
   */
  async setPolicy(policyContractAddress: string): Promise<string> {
    const hook = this.getHookContract();
    const tx = await hook.setPolicy(policyContractAddress);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Read the policy contract address registered for an evaluator.
   * Returns the zero address if no policy is set.
   */
  async getPolicyAddress(evaluatorAddress: string): Promise<string> {
    const hook = this.getHookContract();
    return hook.evaluatorPolicies(evaluatorAddress);
  }

  /**
   * Remove the caller's policy. Verification will only check proof authenticity.
   */
  async removePolicy(): Promise<string> {
    const hook = this.getHookContract();
    const tx = await hook.removePolicy();
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Check if a provider's bundle has already been verified on-chain.
   */
  async isVerified(
    providerAddress: string,
    chainHash: string,
  ): Promise<boolean> {
    const hook = this.getHookContract();
    return hook.isProviderVerified(providerAddress, chainHash);
  }

  private getVerifierContract(): ethers.Contract {
    if (!this.verifierAddress) {
      throw new Error(
        "TrustLayerVerifier address is not configured. Pass it via OnChainSubmitter overrides or deployment config.",
      );
    }
    return new ethers.Contract(this.verifierAddress, VERIFIER_ABI, this.signer);
  }

  private getHookContract(): ethers.Contract {
    if (!this.hookAddress) {
      throw new Error(
        "TrustLayerACPHook address is not configured. Pass it via OnChainSubmitter overrides or deployment config.",
      );
    }
    return new ethers.Contract(this.hookAddress, HOOK_ABI, this.signer);
  }

  /**
   * Convert SDK ProofBundle → on-chain struct layout.
   *
   * Key mapping:
   *  - ProofStep.primusTaskId → on-chain ProofStep.primusTaskId
   *  - ProofStep.attestation.{attestor, attestorUrl} → Attestation.attestors[0]
   *  - ProofStep.attestation.signature → Attestation.signatures[0]
   *  - PrimusAttestation.request (single) → AttNetworkRequest
   *  - PrimusAttestation.responseResolve → reponseResolve (official typo)
   */
  private encodeBundle(bundle: ProofBundle): any {
    return {
      steps: bundle.steps.map((s) => {
        const att = s.attestation;
        const core = att.attestation;
        return {
          stepId: s.stepId,
          primusTaskId: s.primusTaskId,
          attestation: {
            recipient: core.recipient,
            request: {
              url: core.request.url,
              header: typeof core.request.header === "string"
                ? core.request.header
                : JSON.stringify(core.request.header),
              method: core.request.method,
              body: core.request.body,
            },
            reponseResolve: core.responseResolve.map((r) => ({
              keyName: r.keyName,
              parseType: r.parseType,
              parsePath: r.parsePath,
            })),
            data: core.data,
            attConditions: core.attConditions,
            timestamp: BigInt(core.timestamp),
            additionParams: core.additionParams,
            attestors: [{
              attestorAddr: att.attestor,
              url: att.attestorUrl,
            }],
            signatures: [att.signature],
          },
        };
      }),
      chainHash: bundle.chainHash,
      providerWallet: bundle.providerWallet,
      builtAt: BigInt(bundle.builtAt),
    };
  }

  private encodeBundleForHook(bundle: ProofBundle): string {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    return abi.encode([PROOF_BUNDLE_TUPLE], [this.encodeBundle(bundle)]);
  }
}
