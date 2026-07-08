// One-time production deployment of ValiquoSettlementLog to Arc Testnet.
// A FRESH instance, separate from the Step-3 isolated test deployment.
// Deployer/owner: TEST_LOG_DEPLOYER_PRIVATE_KEY (already-funded, only ever
// used for deploy/owner actions - never for logging or real funds).
// Logger: SETTLEMENT_LOGGER_PRIVATE_KEY's address, set via the constructor,
// exactly matching the pattern already proven in the isolated test.
import { readFileSync, writeFileSync } from "node:fs";
import solc from "solc";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const deployerKey = process.env.TEST_LOG_DEPLOYER_PRIVATE_KEY;
const loggerAddress = process.env.SETTLEMENT_LOGGER_ADDRESS;
if (!deployerKey) {
  console.log(JSON.stringify({ ok: false, error: "TEST_LOG_DEPLOYER_PRIVATE_KEY not set." }));
  process.exit(1);
}
if (!loggerAddress) {
  console.log(JSON.stringify({ ok: false, error: "SETTLEMENT_LOGGER_ADDRESS not set (pass the new logger's public address)." }));
  process.exit(1);
}

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network/"] } },
};

try {
  const source = readFileSync(new URL("../contracts/ValiquoSettlementLog.sol", import.meta.url), "utf8");
  const input = {
    language: "Solidity",
    sources: { "ValiquoSettlementLog.sol": { content: source } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    console.log(JSON.stringify({ ok: false, error: "Compilation failed", details: errors.map((e) => e.formattedMessage) }));
    process.exit(1);
  }

  const contract = output.contracts["ValiquoSettlementLog.sol"]["ValiquoSettlementLog"];
  const abi = contract.abi;
  const bytecode = `0x${contract.evm.bytecode.object}`;

  const deployer = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const walletClient = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() });

  console.log(JSON.stringify({ step: "compiled", deployerAddress: deployer.address, loggerAddress }));

  const deployTxHash = await walletClient.deployContract({ abi, bytecode, args: [loggerAddress] });
  console.log(JSON.stringify({ step: "deploy_tx_sent", txHash: deployTxHash }));

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (!receipt.contractAddress) {
    console.log(JSON.stringify({ ok: false, error: "No contract address in deployment receipt.", receipt }));
    process.exit(1);
  }

  writeFileSync(
    new URL("./.settlement-log-production-deployment.json", import.meta.url),
    JSON.stringify({ address: receipt.contractAddress, abi, deployerAddress: deployer.address, loggerAddress }, null, 2)
  );

  console.log(JSON.stringify({
    ok: true,
    contractAddress: receipt.contractAddress,
    deployTxHash,
    deployGasUsed: receipt.gasUsed.toString(),
    loggerAddress,
    explorerUrl: `https://testnet.arcscan.app/address/${receipt.contractAddress}`,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
