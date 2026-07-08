// Runs the 5 approved pre-production test cases against the isolated
// ValiquoSettlementLog test deployment (see deploy-settlement-log-test.mjs).
// Fully separate from SELLER_ADDRESS/SELLER_PRIVATE_KEY and the live
// production flow - operates only on the throwaway deployer/logger key and
// freshly generated, unfunded addresses used purely as data values or as
// simulated (never real) callers.
import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import crypto from "node:crypto";

const deployerKey = process.env.TEST_LOG_DEPLOYER_PRIVATE_KEY;
if (!deployerKey) {
  console.log(JSON.stringify({ ok: false, error: "TEST_LOG_DEPLOYER_PRIVATE_KEY not set." }));
  process.exit(1);
}

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network/"] } },
};

function uuidToBytes16(uuid) {
  return `0x${uuid.replace(/-/g, "")}`;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(JSON.stringify({ testCase: name, pass, detail }));
}

try {
  const deployment = JSON.parse(
    readFileSync(new URL("./.settlement-log-test-deployment.json", import.meta.url), "utf8")
  );
  const { address, abi } = deployment;

  const deployer = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() });

  const payerA = privateKeyToAccount(generatePrivateKey()).address;
  const payerB = privateKeyToAccount(generatePrivateKey()).address;
  const payerC = privateKeyToAccount(generatePrivateKey()).address;
  const unauthorizedCaller = privateKeyToAccount(generatePrivateKey()).address;

  // --- Test case 1: successful log ---------------------------------------
  const tx1 = await deployerWallet.writeContract({
    address,
    abi,
    functionName: "logSettlement",
    args: ["get_btc_cycle_regime", 8000n, uuidToBytes16(crypto.randomUUID()), payerA],
  });
  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
  const countAfter1 = await publicClient.readContract({ address, abi, functionName: "settlementCount" });
  const distinctAfter1 = await publicClient.readContract({ address, abi, functionName: "distinctPayerCount" });
  record("1_successful_log", countAfter1 === 1n && distinctAfter1 === 1n, {
    txHash: tx1,
    gasUsed: receipt1.gasUsed.toString(),
    effectiveGasPrice: receipt1.effectiveGasPrice.toString(),
    settlementCount: countAfter1.toString(),
    distinctPayerCount: distinctAfter1.toString(),
  });

  // --- Test case 2: access-control rejection (simulated, no real tx) -----
  let accessControlRejected = false;
  let accessControlError = null;
  try {
    await publicClient.simulateContract({
      account: unauthorizedCaller,
      address,
      abi,
      functionName: "logSettlement",
      args: ["get_btc_cycle_regime", 8000n, uuidToBytes16(crypto.randomUUID()), payerA],
    });
  } catch (err) {
    accessControlRejected = true;
    accessControlError = String(err?.shortMessage ?? err?.message ?? err);
  }
  const countAfter2 = await publicClient.readContract({ address, abi, functionName: "settlementCount" });
  record("2_access_control_rejection", accessControlRejected && countAfter2 === 1n, {
    revertedAsExpected: accessControlRejected,
    revertReason: accessControlError,
    settlementCountUnchanged: countAfter2 === 1n,
  });

  // --- Test case 3: distinct-user-count correctness -----------------------
  const tx3a = await deployerWallet.writeContract({
    address,
    abi,
    functionName: "logSettlement",
    args: ["get_lth_behavior", 1500n, uuidToBytes16(crypto.randomUUID()), payerA],
  });
  const receipt3a = await publicClient.waitForTransactionReceipt({ hash: tx3a });

  const tx3b = await deployerWallet.writeContract({
    address,
    abi,
    functionName: "logSettlement",
    args: ["get_entry_risk", 1500n, uuidToBytes16(crypto.randomUUID()), payerB],
  });
  const receipt3b = await publicClient.waitForTransactionReceipt({ hash: tx3b });

  const countAfter3 = await publicClient.readContract({ address, abi, functionName: "settlementCount" });
  const distinctAfter3 = await publicClient.readContract({ address, abi, functionName: "distinctPayerCount" });
  record("3_distinct_user_count", countAfter3 === 3n && distinctAfter3 === 2n, {
    settlementCount: countAfter3.toString(),
    distinctPayerCount: distinctAfter3.toString(),
    repeatPayerGasUsed: receipt3a.gasUsed.toString(),
    newPayerGasUsed: receipt3b.gasUsed.toString(),
  });

  // --- Test case 4: logger rotation ---------------------------------------
  const newLoggerKey = generatePrivateKey();
  const newLogger = privateKeyToAccount(newLoggerKey);

  // Fund the new logger with a small amount of native gas from the
  // already-funded deployer so it can submit its own transaction.
  const fundTx = await deployerWallet.sendTransaction({ to: newLogger.address, value: parseEther("0.5") });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });

  const rotateTx = await deployerWallet.writeContract({
    address,
    abi,
    functionName: "setLogger",
    args: [newLogger.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: rotateTx });

  // Old logger (deployer) should now be rejected.
  let oldLoggerRejected = false;
  try {
    await publicClient.simulateContract({
      account: deployer.address,
      address,
      abi,
      functionName: "logSettlement",
      args: ["get_nupl_sentiment", 1500n, uuidToBytes16(crypto.randomUUID()), payerC],
    });
  } catch {
    oldLoggerRejected = true;
  }

  // New logger should now succeed.
  const newLoggerWallet = createWalletClient({ account: newLogger, chain: arcTestnet, transport: http() });
  const tx4 = await newLoggerWallet.writeContract({
    address,
    abi,
    functionName: "logSettlement",
    args: ["compare_to_2021_top", 2000n, uuidToBytes16(crypto.randomUUID()), payerC],
  });
  const receipt4 = await publicClient.waitForTransactionReceipt({ hash: tx4 });
  const countAfter4 = await publicClient.readContract({ address, abi, functionName: "settlementCount" });
  const distinctAfter4 = await publicClient.readContract({ address, abi, functionName: "distinctPayerCount" });
  record(
    "4_logger_rotation",
    oldLoggerRejected && countAfter4 === 4n && distinctAfter4 === 3n,
    {
      oldLoggerRejectedAfterRotation: oldLoggerRejected,
      newLoggerTxHash: tx4,
      newLoggerGasUsed: receipt4.gasUsed.toString(),
      settlementCount: countAfter4.toString(),
      distinctPayerCount: distinctAfter4.toString(),
    }
  );

  // --- Test case 5: real gas measurement ----------------------------------
  const decimals = 18n;
  function toNativeUnits(gasUsed, gasPrice) {
    const wei = gasUsed * gasPrice;
    return Number(wei) / Number(10n ** decimals);
  }
  record("5_real_gas_measurement", true, {
    note: "Native gas token on Arc is USDC (18 decimals) - cost figures below are in that unit.",
    firstTimePayer_gasUsed: receipt1.gasUsed.toString(),
    firstTimePayer_costUsdcEquivalent: toNativeUnits(receipt1.gasUsed, receipt1.effectiveGasPrice),
    repeatPayer_gasUsed: receipt3a.gasUsed.toString(),
    repeatPayer_costUsdcEquivalent: toNativeUnits(receipt3a.gasUsed, receipt3a.effectiveGasPrice),
  });

  const allPassed = results.every((r) => r.pass);
  console.log(JSON.stringify({ ok: allPassed, summary: results.map((r) => ({ name: r.name, pass: r.pass })) }));
  process.exit(allPassed ? 0 : 1);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
