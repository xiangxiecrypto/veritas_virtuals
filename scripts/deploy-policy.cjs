/**
 * Deploy an IEvaluatorPolicy contract and optionally register it on the hook.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-policy.cjs --network baseSepolia
 *
 * Environment variables:
 *   WALLET_PRIVATE_KEY              — deployer & evaluator wallet
 *   POLICY_CONTRACT                 — artifact name (default: FactCheckPolicy)
 *   POLICY_MAX_AGE_SECS            — constructor arg for FactCheckPolicy (default: 600)
 *   POLICY_TRUSTED_DOMAINS         — comma-separated domain list for FactCheckPolicy
 *   TRUST_LAYER_ACP_HOOK_ADDRESS   — if set, auto-registers the policy on the hook
 *   BASE_SEPOLIA_TRUST_LAYER_ACP_HOOK_ADDRESS — network-specific override
 */
const hre = require("hardhat");
const { ethers } = require("ethers");

function resolveNetworkEnv(networkName, key) {
  const prefix = networkName === "baseSepolia" ? "BASE_SEPOLIA" : "BASE_MAINNET";
  return process.env[`${prefix}_${key}`] || process.env[key];
}

async function main() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("WALLET_PRIVATE_KEY is required");
  }

  const policyName = process.env.POLICY_CONTRACT ?? "FactCheckPolicy";
  const maxAgeSecs = Number(process.env.POLICY_MAX_AGE_SECS ?? "600");

  const rpcUrl = hre.network.config.url;
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for network "${hre.network.name}"`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log(`Deploying ${policyName} from ${signer.address}...`);

  const artifact = await hre.artifacts.readArtifact(policyName);
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    signer,
  );

  let policy;
  if (policyName === "FactCheckPolicy") {
    const domainsStr = process.env.POLICY_TRUSTED_DOMAINS ?? "";
    const domains = domainsStr
      ? domainsStr.split(",").map((d) => d.trim()).filter(Boolean)
      : [];
    console.log(`  maxAgeSecs: ${maxAgeSecs}`);
    console.log(`  trustedDomains: [${domains.join(", ")}]`);
    policy = await factory.deploy(maxAgeSecs, domains);
  } else {
    policy = await factory.deploy();
  }

  await policy.deploymentTransaction().wait();
  const policyAddress = await policy.getAddress();
  console.log(`${policyName} deployed to:`, policyAddress);

  const hookAddress = resolveNetworkEnv(
    hre.network.name,
    "TRUST_LAYER_ACP_HOOK_ADDRESS",
  );
  if (hookAddress) {
    console.log("Registering policy on TrustLayerACPHook...");
    const hookAbi = [
      "function setPolicy(address policyContract) external",
    ];
    const hook = new ethers.Contract(hookAddress, hookAbi, signer);
    const tx = await hook.setPolicy(policyAddress);
    await tx.wait();
    console.log("Policy registered on hook. TX:", tx.hash);
  } else {
    console.log(
      "TRUST_LAYER_ACP_HOOK_ADDRESS not set — skipping hook registration.",
      "Call hook.setPolicy() manually to activate.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
