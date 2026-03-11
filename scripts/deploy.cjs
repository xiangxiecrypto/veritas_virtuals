const hre = require("hardhat");
const { ethers } = require("ethers");

async function main() {
  const primusVerifierAddress = process.env.PRIMUS_VERIFIER_ADDRESS;
  if (!primusVerifierAddress) {
    throw new Error("PRIMUS_VERIFIER_ADDRESS is required to deploy contracts");
  }
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

