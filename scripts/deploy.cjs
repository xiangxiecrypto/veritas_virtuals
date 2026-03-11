const hre = require("hardhat");
const { ethers } = require("ethers");

// Official Primus zkTLS verifier — same address on Base mainnet & Sepolia
const DEFAULT_PRIMUS_ADDRESS = "0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE";

async function main() {
  const primusVerifierAddress =
    process.env.PRIMUS_VERIFIER_ADDRESS || DEFAULT_PRIMUS_ADDRESS;
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("WALLET_PRIVATE_KEY is required to deploy contracts");
  }

  const maxAttestationAgeSecs = Number(
    process.env.MAX_ATTESTATION_AGE_SECS ?? "600",
  );

  const rpcUrl = hre.network.config.url;
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for network "${hre.network.name}"`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const verifierArtifact = await hre.artifacts.readArtifact(
    "TrustLayerVerifier",
  );
  const verifierFactory = new ethers.ContractFactory(
    verifierArtifact.abi,
    verifierArtifact.bytecode,
    signer,
  );
  const verifier = await verifierFactory.deploy(
    primusVerifierAddress,
    maxAttestationAgeSecs,
  );
  await verifier.deploymentTransaction().wait();
  const verifierAddress = await verifier.getAddress();

  const hookArtifact = await hre.artifacts.readArtifact(
    "TrustLayerACPHook",
  );
  const hookFactory = new ethers.ContractFactory(
    hookArtifact.abi,
    hookArtifact.bytecode,
    signer,
  );
  const hook = await hookFactory.deploy(verifierAddress);
  await hook.deploymentTransaction().wait();
  const hookAddress = await hook.getAddress();

  console.log("TrustLayerVerifier deployed to:", verifierAddress);
  console.log("TrustLayerACPHook deployed to:", hookAddress);
  console.log("Primus verifier used:", primusVerifierAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

