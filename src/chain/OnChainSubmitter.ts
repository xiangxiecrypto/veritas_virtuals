import { ethers } from "ethers";
import { ProofBundle, OnChainVerificationResult } from "../types/index.js";

// Minimal ABI for TrustLayerVerifier
const VERIFIER_ABI = [
  "function verifyProofBundle(tuple(tuple(string stepId, tuple(tuple(address recipient, tuple(string url, string header, string method, string body)[] request, tuple(tuple(string keyName, string parseType, string parsePath) oneUrlResponseResolve)[][] responseResolve, string data, string attConditions, uint256 timestamp, string additionParams) attestation, address attestor, string signature, string reportTxHash, string taskId, uint256 attestationTime, string attestorUrl) attestation) [] steps, bytes32 chainHash, address providerWallet, uint256 builtAt) calldata bundle, address providerAddress) view returns (bool)",
  "event TrustLayerVerified(uint256 indexed jobId, address indexed provider, bytes32 chainHash)",
];

// Minimal ABI for TrustLayerACPHook
const HOOK_ABI = [
  "function verifyDeliverable(uint256 jobId, address providerAddress, bytes calldata encodedBundle) external returns (bool)",
  "function isProviderVerified(address provider, bytes32 chainHash) external view returns (bool)",
];

export const CONTRACT_ADDRESSES = {
  base_mainnet: {
    TrustLayerVerifier: "", // pending deployment
    TrustLayerACPHook: "", // pending deployment
    PrimusZKTLS: "", // unconfirmed in repo; inject from deployment/config
  },
  base_sepolia: {
    TrustLayerVerifier: "", // pending deployment
    TrustLayerACPHook: "", // pending deployment
    PrimusZKTLS: "", // unconfirmed in repo; inject from deployment/config
  },
} as const;

export type Network = keyof typeof CONTRACT_ADDRESSES;

export class OnChainSubmitter {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private verifier: ethers.Contract;
  private hook: ethers.Contract;

  constructor(
    privateKey: string,
    network: Network = "base_mainnet",
    rpcUrl?: string,
  ) {
    const rpc = rpcUrl ?? (network === "base_mainnet"
      ? "https://mainnet.base.org"
      : "https://sepolia.base.org");

    this.provider = new ethers.JsonRpcProvider(rpc);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    const addresses = CONTRACT_ADDRESSES[network];
    this.verifier = new ethers.Contract(
      addresses.TrustLayerVerifier,
      VERIFIER_ABI,
      this.signer,
    );
    this.hook = new ethers.Contract(
      addresses.TrustLayerACPHook,
      HOOK_ABI,
      this.signer,
    );
  }

  /**
   * Dry-run verify a ProofBundle using eth_call (no gas).
   * Use this in the Buyer's onEvaluate to check before signing.
   */
  async verifyBundle(
    bundle: ProofBundle,
    providerAddress: string,
  ): Promise<OnChainVerificationResult> {
    try {
      const result: boolean = await this.verifier.verifyProofBundle(
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
   * In production, ACP Job contracts call the hook during evaluation.
   */
  async submitBundle(
    jobId: number | bigint,
    bundle: ProofBundle,
    providerAddress: string,
  ): Promise<OnChainVerificationResult> {
    try {
      const encoded = this.encodeBundleForHook(bundle);
      const tx = await this.hook.verifyDeliverable(jobId, providerAddress, encoded);
      const receipt = await tx.wait();
      return { verified: true, txHash: receipt.hash };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  /**
   * Check if a provider's bundle has already been verified on-chain.
   */
  async isVerified(
    providerAddress: string,
    chainHash: string,
  ): Promise<boolean> {
    return this.hook.isProviderVerified(
      providerAddress,
      chainHash,
    );
  }

  private encodeBundle(bundle: ProofBundle): any {
    // Transforms ProofBundle to match Solidity struct layout
    return {
      steps: bundle.steps.map((s) => ({
        stepId: s.stepId,
        attestation: s.attestation,
      })),
      chainHash: bundle.chainHash,
      providerWallet: bundle.providerWallet,
      builtAt: BigInt(bundle.builtAt),
    };
  }

  private encodeBundleForHook(bundle: ProofBundle): string {
    // Solidity: abi.decode(encodedBundle, (ITrustLayer.ProofBundle))
    // Therefore the hook expects `abi.encode(ProofBundle)`.
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const tupleType =
      "tuple(" +
      "tuple(string stepId, " +
      "tuple(" +
      "tuple(address recipient, tuple(string url, string header, string method, string body)[] request, tuple(tuple(string keyName, string parseType, string parsePath) oneUrlResponseResolve)[][] responseResolve, string data, string attConditions, uint256 timestamp, string additionParams) attestation, " +
      "address attestor, string signature, string reportTxHash, string taskId, uint256 attestationTime, string attestorUrl" +
      ")" +
      " attestation" +
      ")[] steps, " +
      "bytes32 chainHash, address providerWallet, uint256 builtAt" +
      ")";

    return abi.encode([tupleType], [this.encodeBundle(bundle)]);
  }
}
