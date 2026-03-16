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
// On-chain ProofStep layout (from IVeritas.sol):
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
  "event VeritasVerified(address indexed provider, bytes32 indexed chainHash, uint256 stepCount, uint256 verifiedAt)",
];

const HOOK_ABI = [
  "function setPolicy(address policyContract) external",
  "function removePolicy() external",
  "function evaluatorPolicies(address evaluator) view returns (address)",
  "function validateJobSubmission(uint256 jobId, bytes calldata encodedBundle) external view returns (bool)",
  "function isProviderVerified(address provider, bytes32 chainHash) external view returns (bool)",
  "function isJobVerified(uint256 jobId) external view returns (bool)",
];

const ERC8183_ABI = [
  "function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external",
  "function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external",
  "function getJob(uint256 jobId) view returns (tuple(uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))",
];

const PRIMUS_ZKTLS_ADDRESS = "0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE";

export const CONTRACT_ADDRESSES = {
  base_mainnet: {
    VeritasVerifier: "",
    VeritasERC8183Hook: "",
    ERC8183AgenticCommerce: "",
    PrimusZKTLS: PRIMUS_ZKTLS_ADDRESS,
  },
  base_sepolia: {
    VeritasVerifier: "0x5D39Ef731fDfd3d49D033724d70be0FD0E31172c",
    VeritasERC8183Hook: "",
    ERC8183AgenticCommerce: "",
    PrimusZKTLS: PRIMUS_ZKTLS_ADDRESS,
  },
} as const;

export type Network = keyof typeof CONTRACT_ADDRESSES;
export interface ContractAddressOverrides {
  VeritasVerifier?: string;
  VeritasERC8183Hook?: string;
  ERC8183AgenticCommerce?: string;
  PrimusZKTLS?: string;
}

export class OnChainSubmitter {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private verifierAddress?: string;
  private hookAddress?: string;
  private commerceAddress?: string;

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

    const definedOverrides = Object.fromEntries(
      Object.entries(overrides ?? {}).filter(([, value]) => Boolean(value)),
    ) as ContractAddressOverrides;
    const addresses = { ...CONTRACT_ADDRESSES[network], ...definedOverrides };
    this.verifierAddress = addresses.VeritasVerifier || undefined;
    this.hookAddress = addresses.VeritasERC8183Hook || undefined;
    this.commerceAddress = addresses.ERC8183AgenticCommerce || undefined;
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
   * Dry-run an ERC-8183 submission against the Veritas hook.
   * This checks the same proof + policy logic that will run during `submit()`.
   */
  async validateJobSubmission(
    jobId: number | bigint,
    bundle: ProofBundle,
  ): Promise<OnChainVerificationResult> {
    try {
      const hook = this.getHookContract();
      const result: boolean = await hook.validateJobSubmission(
        jobId,
        this.encodeBundleBytes(bundle),
      );
      return { verified: result };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  /**
   * Submit a verified Veritas bundle into an ERC-8183 job.
   *
   * The provider should call this while moving a job into `Submitted`.
   * `deliverable` is the Veritas `bundle.chainHash`, and `optParams`
   * is the ABI-encoded ProofBundle expected by the hook.
   */
  async submitJob(
    jobId: number | bigint,
    bundle: ProofBundle,
  ): Promise<OnChainVerificationResult> {
    try {
      const commerce = this.getCommerceContract();
      const tx = await commerce.submit(
        jobId,
        bundle.chainHash,
        this.encodeBundleBytes(bundle),
      );
      const receipt = await tx.wait();
      return { verified: true, txHash: receipt.hash };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  /**
   * Evaluator-side completion helper for ERC-8183 jobs after hook validation.
   */
  async completeJob(
    jobId: number | bigint,
    reason: string,
    optParams = "0x",
  ): Promise<string> {
    const commerce = this.getCommerceContract();
    const reasonHash = ethers.id(reason);
    const tx = await commerce.complete(jobId, reasonHash, optParams);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Point the caller's evaluator slot to a deployed IEvaluatorPolicy contract.
   * After this, ERC-8183 hook validation automatically calls `policy.check()`.
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
   * Build the exact ERC-8183 `submit()` payload expected by VeritasERC8183Hook.
   */
  prepareJobSubmission(bundle: ProofBundle): {
    deliverable: string;
    optParams: string;
  } {
    return {
      deliverable: bundle.chainHash,
      optParams: this.encodeBundleBytes(bundle),
    };
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

  /**
   * Check whether a specific ERC-8183 job has already passed Veritas verification.
   */
  async isJobVerified(jobId: number | bigint): Promise<boolean> {
    const hook = this.getHookContract();
    return hook.isJobVerified(jobId);
  }

  private getVerifierContract(): ethers.Contract {
    if (!this.verifierAddress) {
      throw new Error(
        "VeritasVerifier address is not configured. Pass it via OnChainSubmitter overrides or deployment config.",
      );
    }
    return new ethers.Contract(this.verifierAddress, VERIFIER_ABI, this.signer);
  }

  private getHookContract(): ethers.Contract {
    if (!this.hookAddress) {
      throw new Error(
        "VeritasERC8183Hook address is not configured. Pass it via OnChainSubmitter overrides or deployment config.",
      );
    }
    return new ethers.Contract(this.hookAddress, HOOK_ABI, this.signer);
  }

  private getCommerceContract(): ethers.Contract {
    if (!this.commerceAddress) {
      throw new Error(
        "ERC8183AgenticCommerce address is not configured. Pass it via OnChainSubmitter overrides or deployment config.",
      );
    }
    return new ethers.Contract(this.commerceAddress, ERC8183_ABI, this.signer);
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

  encodeBundleBytes(bundle: ProofBundle): string {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    return abi.encode([PROOF_BUNDLE_TUPLE], [this.encodeBundle(bundle)]);
  }
}
