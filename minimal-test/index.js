import { Synapse, RPC_URLS, TIME_CONSTANTS } from "@filoz/synapse-sdk";
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  console.log("=== FOC Minimal Test ===\n");

  // 1) Initialize the Synapse SDK
  console.log("1. Initializing Synapse SDK...");
  const synapse = await Synapse.create({
    privateKey: PRIVATE_KEY,
    rpcURL: RPC_URLS.calibration.http,
  });

  const signer = synapse.getSigner();
  const address = await signer.getAddress();
  console.log(`   Wallet: ${address}`);
  console.log(`   Network: calibration`);
  console.log(`   Warm Storage: ${synapse.getWarmStorageAddress()}`);

  // Check balances
  console.log("\n2. Checking balances...");
  try {
    const accountInfo = await synapse.payments.accountInfo();
    console.log(`   FOC Funds: ${ethers.formatUnits(accountInfo.funds || accountInfo.balance || 0n, 18)} USDFC`);
    console.log(`   Available: ${ethers.formatUnits(accountInfo.availableFunds || accountInfo.availableBalance || 0n, 18)} USDFC`);
  } catch (e) {
    console.log(`   No FOC account yet`);
  }

  // 2) Fund & approve (single transaction)
  console.log("\n3. Depositing USDFC and approving operator...");
  try {
    const depositAmount = ethers.parseUnits("2.5", 18);

    // Try the combined method first
    if (typeof synapse.payments.depositWithPermitAndApproveOperator === 'function') {
      console.log("   Using depositWithPermitAndApproveOperator...");
      const tx = await synapse.payments.depositWithPermitAndApproveOperator(
        depositAmount,
        synapse.getWarmStorageAddress(),
        ethers.MaxUint256,
        ethers.MaxUint256,
        TIME_CONSTANTS.EPOCHS_PER_MONTH,
      );
      console.log(`   TX: ${tx.hash}`);
      await tx.wait();
      console.log("   Deposit and approval complete!");
    } else {
      console.log("   depositWithPermitAndApproveOperator not available, trying deposit...");
      const tx = await synapse.payments.deposit(depositAmount);
      console.log(`   TX: ${tx.hash}`);
      await tx.wait();
      console.log("   Deposit complete!");
    }
  } catch (e) {
    console.log(`   Deposit error: ${e.message}`);
    console.log("   Continuing with upload attempt...");
  }

  // 3) Upload
  console.log("\n4. Uploading test data...");
  try {
    const data = new TextEncoder().encode(
      `FOC Chaintest - ${new Date().toISOString()} - ` +
      `This is a test upload to verify the Filecoin Onchain Cloud SDK is working correctly. ` +
      `The minimum upload size is 127 bytes so this message is padded accordingly.`
    );
    console.log(`   Data size: ${data.length} bytes`);

    const result = await synapse.storage.upload(data);
    console.log(`   Upload complete!`);
    console.log(`   PieceCID: ${result.pieceCid}`);
    console.log(`   Size: ${result.size} bytes`);

    // 4) Download to verify
    console.log("\n5. Downloading to verify...");
    const downloaded = await synapse.storage.download(result.pieceCid);
    const decoded = new TextDecoder().decode(downloaded);
    console.log(`   Downloaded ${downloaded.length} bytes`);
    console.log(`   Content matches: ${decoded.includes("FOC Chaintest")}`);

    console.log("\n=== SUCCESS ===");
  } catch (e) {
    console.error(`\n   Upload failed: ${e.message}`);
    if (e.message.includes("recordKeeper")) {
      console.log("\n   Note: 'recordKeeper' error suggests contract mismatch.");
      console.log("   Check if SDK version matches current contracts.");
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
