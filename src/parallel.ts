import http from 'node:http';
import https from 'node:https';
import { ethers } from 'ethers';
import { Synapse, RPC_URLS } from '@filoz/synapse-sdk';
import type { Config } from './config.js';
import { generateRandomData, formatBytes, formatDuration, log, logError, sleep } from './utils.js';

// Increase connection limits for high parallelism
http.globalAgent.maxSockets = 1000;
https.globalAgent.maxSockets = 1000;
http.globalAgent.maxFreeSockets = 5000;
https.globalAgent.maxFreeSockets = 5000;

interface ProviderInfo {
  providerId?: number;
  id?: number;
  address?: string;
  name?: string;
}

interface ContextResult {
  contextId: number;
  provider: ProviderInfo | null;
  datasetId: number | null;
  isExistingDataset: boolean;
  rounds: RoundResult[];
  startTime: number;
  endTime: number;
}

interface RoundResult {
  roundNum: number;
  uploads: UploadResult[];
  startTime: number;
  endTime: number;
}

interface UploadResult {
  uploadNum: number;
  success: boolean;
  pieceCid?: string;
  pieceId?: number;
  txHash?: string;
  error?: string;
  duration: number;
}

export class ParallelChaintest {
  private config: Config;
  private synapse: Synapse | null = null;
  private results: ContextResult[] = [];

  constructor(config: Config) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    log('Initializing Parallel Chaintest...');
    log(`HTTP connection limits: maxSockets=${http.globalAgent.maxSockets}, maxFreeSockets=${http.globalAgent.maxFreeSockets}`);
    log(`Network: ${this.config.network}`);
    log(`Parallel contexts: ${this.config.parallelContexts}`);
    log(`Parallel uploads per context: ${this.config.parallelUploads}`);
    log(`Rounds per context: ${this.config.uploadsPerContext}`);
    log(`Context start delay: ${this.config.contextStartDelayMs}ms`);
    log(`Data size: ${formatBytes(this.config.dataSizeBytes)}`);
    log(`Max retries per upload: ${this.config.maxRetries}`);
    if (this.config.providerId !== undefined) {
      log(`Forcing provider: ${this.config.providerId}`);
    }
    if (this.config.excludeProviderIds.length > 0) {
      log(`Excluding providers: ${this.config.excludeProviderIds.join(', ')}`);
    }

    const rpcUrl = this.config.network === 'mainnet'
      ? RPC_URLS.mainnet.http
      : RPC_URLS.calibration.http;

    this.synapse = await Synapse.create({
      privateKey: this.config.privateKey,
      rpcURL: rpcUrl,
      withCDN: this.config.withCDN,
      dev: true,
      telemetry: { sentryInitOptions: { enabled: true } },
    });

    log('Synapse SDK initialized (dev mode)');
    const signer = this.synapse.getSigner();
    const address = await signer.getAddress();
    log(`Wallet address: ${address}`);

    // Print wallet balances
    try {
      const filBalance = await this.synapse.payments.walletBalance();
      log(`FIL Balance: ${ethers.formatUnits(filBalance, 18)} FIL`);
    } catch (e) {
      log(`FIL Balance: unknown`);
    }

    try {
      const usdfcBalance = await this.synapse.payments.walletBalance('USDFC');
      log(`USDFC Wallet: ${ethers.formatUnits(usdfcBalance, 18)} USDFC`);
    } catch (e) {
      log(`USDFC Wallet: unknown`);
    }

    // Print FOC account info
    try {
      const accountInfo = await this.synapse.payments.accountInfo();
      log(`FOC Funds: ${ethers.formatUnits(accountInfo.funds, 18)} USDFC`);
      log(`FOC Available: ${ethers.formatUnits(accountInfo.availableFunds, 18)} USDFC`);
    } catch (e) {
      log(`FOC Account: Not found (run setup first)`);
    }
  }

  private async runContext(contextId: number): Promise<ContextResult> {
    const result: ContextResult = {
      contextId,
      provider: null,
      datasetId: null,
      isExistingDataset: false,
      rounds: [],
      startTime: Date.now(),
      endTime: 0,
    };

    log(`[CTX-${contextId}] Creating storage context...`);

    try {
      const storageContext = await this.synapse!.storage.createContext({
        forceCreateDataSet: true,
        providerId: this.config.providerId,
        excludeProviderIds: this.config.excludeProviderIds.length > 0 ? this.config.excludeProviderIds : undefined,
        callbacks: {
          onProviderSelected: (info: any) => {
            const providerId = info.providerId ?? info.id;
            result.provider = { ...info, providerId };
            log(`[CTX-${contextId}] Provider selected: ID=${providerId}`);
          },
          onDataSetResolved: (info: { isExisting: boolean; dataSetId: number; provider?: any }) => {
            result.datasetId = info.dataSetId;
            result.isExistingDataset = info.isExisting;
            if (info.provider && !result.provider) {
              const providerId = info.provider.providerId ?? info.provider.id;
              result.provider = { ...info.provider, providerId };
            }
            const pid = result.provider?.providerId ?? result.provider?.id ?? 'unknown';
            log(`[CTX-${contextId}] Dataset: ${info.dataSetId} (existing: ${info.isExisting}), Provider: ${pid}`);
          },
        },
      });

      // Get info directly from context
      const ctxDataSetId = storageContext.dataSetId;
      const ctxProvider = storageContext.provider;
      const ctxServiceProvider = storageContext.serviceProvider;

      result.datasetId = ctxDataSetId ?? result.datasetId;
      if (ctxProvider) {
        result.provider = { ...ctxProvider, providerId: (ctxProvider as any).providerId ?? (ctxProvider as any).id };
      }

      const provId = result.provider?.providerId ?? result.provider?.id ?? 'unknown';
      log(`[CTX-${contextId}] Context ready:`);
      log(`[CTX-${contextId}]   DataSet ID: ${ctxDataSetId}`);
      log(`[CTX-${contextId}]   Provider ID: ${provId}`);
      log(`[CTX-${contextId}]   Service Provider: ${ctxServiceProvider}`);

      // Try to get provider info
      try {
        const providerInfo = await storageContext.getProviderInfo();
        log(`[CTX-${contextId}]   Provider Info: ${JSON.stringify(providerInfo)}`);
      } catch (e) {
        // ignore
      }

      log(`[CTX-${contextId}] Starting ${this.config.uploadsPerContext} rounds of ${this.config.parallelUploads} parallel uploads (${this.config.uploadIntervalSeconds}s between round starts)...`);

      // Run M rounds - start each round after X seconds, don't wait for previous to complete
      const roundPromises: Promise<RoundResult>[] = [];
      for (let round = 0; round < this.config.uploadsPerContext; round++) {
        // Start round immediately (first) or after delay
        if (round > 0 && this.config.uploadIntervalSeconds > 0) {
          await sleep(this.config.uploadIntervalSeconds * 1000);
        }

        log(`[CTX-${contextId}] Launching round ${round + 1}...`);
        const roundPromise = this.runRound(contextId, round + 1, storageContext);
        roundPromises.push(roundPromise);
      }

      // Wait for all rounds to complete
      const roundResults = await Promise.all(roundPromises);
      result.rounds = roundResults;

      // Update dataSetId from context (should be set after first upload)
      result.datasetId = storageContext.dataSetId ?? result.datasetId;
      log(`[CTX-${contextId}] All rounds complete. Final DataSet ID: ${result.datasetId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logError(`[CTX-${contextId}] Context failed: ${err.message}`);
    }

    result.endTime = Date.now();
    return result;
  }

  private getProviderIdFromContext(storageContext: Awaited<ReturnType<Synapse['storage']['createContext']>>): string {
    const provider = storageContext.provider as any;
    return String(provider?.providerId ?? provider?.id ?? 'unknown');
  }

  private async runRound(
    contextId: number,
    roundNum: number,
    storageContext: Awaited<ReturnType<Synapse['storage']['createContext']>>
  ): Promise<RoundResult> {
    const roundResult: RoundResult = {
      roundNum,
      uploads: [],
      startTime: Date.now(),
      endTime: 0,
    };

    const provId = this.getProviderIdFromContext(storageContext);
    log(`[CTX-${contextId}][P-${provId}] Round ${roundNum}: Starting ${this.config.parallelUploads} parallel uploads...`);

    // Launch N parallel uploads
    const uploadPromises: Promise<UploadResult>[] = [];
    for (let i = 0; i < this.config.parallelUploads; i++) {
      uploadPromises.push(this.runUpload(contextId, roundNum, i + 1, storageContext));
    }

    // Wait for all uploads to complete
    roundResult.uploads = await Promise.all(uploadPromises);
    roundResult.endTime = Date.now();

    const successes = roundResult.uploads.filter(u => u.success).length;
    // Check if dataSetId is now available
    const currentDataSetId = storageContext.dataSetId;
    log(`[CTX-${contextId}][P-${provId}] Round ${roundNum} complete: ${successes}/${this.config.parallelUploads} succeeded (${formatDuration(roundResult.endTime - roundResult.startTime)}) [DataSet: ${currentDataSetId ?? 'pending'}]`);

    return roundResult;
  }

  private async runUpload(
    contextId: number,
    roundNum: number,
    uploadNum: number,
    storageContext: Awaited<ReturnType<Synapse['storage']['createContext']>>
  ): Promise<UploadResult> {
    const startTime = Date.now();
    const data = generateRandomData(this.config.dataSizeBytes);
    const uploadId = `R${roundNum}U${uploadNum}`;
    const provId = this.getProviderIdFromContext(storageContext);
    const logPrefix = `[CTX-${contextId}][P-${provId}]`;

    let txHash: string | undefined;
    let pieceId: number | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        log(`${logPrefix} ${uploadId} attempt ${attempt}/${this.config.maxRetries}...`);

        const uploadResult = await storageContext.upload(data, {
          onUploadComplete: (pieceCid: string) => {
            log(`${logPrefix} ${uploadId} piece parked: ${pieceCid}`);
          },
          onPieceAdded: (hash: string) => {
            txHash = hash;
            log(`${logPrefix} ${uploadId} on-chain TX: ${hash}`);
          },
          onPiecesAdded: (info: { txHash: string; pieces: Array<{ pieceCid: string }> }) => {
            txHash = info.txHash;
            log(`${logPrefix} ${uploadId} batch TX: ${info.txHash} (${info.pieces.length} pieces)`);
          },
          onPieceConfirmed: (pieceIds: number[]) => {
            if (pieceIds.length > 0) pieceId = pieceIds[0];
            log(`${logPrefix} ${uploadId} confirmed pieceIds: ${pieceIds.join(', ')}`);
          },
          onPiecesConfirmed: (info: { dataSetId: number; pieces: Array<{ pieceId: number; pieceCid: string }> }) => {
            log(`${logPrefix} ${uploadId} confirmed on dataset ${info.dataSetId}: ${info.pieces.map(p => `${p.pieceId}`).join(', ')}`);
          },
        } as any); // Type assertion needed as SDK types may not expose all callbacks

        const pieceCid = String(uploadResult.pieceCid);
        const duration = Date.now() - startTime;

        log(`${logPrefix} ${uploadId} SUCCESS: ${pieceCid} (${formatDuration(duration)})`);

        // Structured result log for stats aggregation
        const datasetId = storageContext.dataSetId ?? 'unknown';
        log(`RESULT status=success provider=${provId} dataset=${datasetId} context=${contextId} round=${roundNum} upload=${uploadNum} pieceCid=${pieceCid} pieceId=${pieceId ?? 'unknown'} txHash=${txHash ?? 'unknown'} duration_ms=${duration} size=${this.config.dataSizeBytes} network=${this.config.network}`);

        // Try to get piece status for PDP info
        try {
          const status = await storageContext.pieceStatus(pieceCid);
          log(`${logPrefix} ${uploadId} PDP Status: ${JSON.stringify(status)}`);
        } catch (e) {
          // ignore
        }

        return {
          uploadNum,
          success: true,
          pieceCid,
          pieceId,
          txHash,
          duration,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          log(`${logPrefix} ${uploadId} failed (attempt ${attempt}): ${err.message}`);
          log(`${logPrefix} ${uploadId} retrying in ${formatDuration(delay)}...`);
          await sleep(delay);
        } else {
          const duration = Date.now() - startTime;
          logError(`${logPrefix} ${uploadId} FAILED after ${this.config.maxRetries} attempts: ${err.message}`);

          // Structured result log for stats aggregation
          const datasetId = storageContext.dataSetId ?? 'unknown';
          log(`RESULT status=fail provider=${provId} dataset=${datasetId} context=${contextId} round=${roundNum} upload=${uploadNum} error="${err.message.replace(/"/g, '\\"')}" txHash=${txHash ?? 'unknown'} duration_ms=${duration} size=${this.config.dataSizeBytes} network=${this.config.network} retries=${this.config.maxRetries}`);

          return {
            uploadNum,
            success: false,
            error: err.message,
            txHash,
            duration,
          };
        }
      }
    }

    const duration = Date.now() - startTime;
    const datasetId = storageContext.dataSetId ?? 'unknown';
    log(`RESULT status=fail provider=${provId} dataset=${datasetId} context=${contextId} round=${roundNum} upload=${uploadNum} error="Unknown error" txHash=unknown duration_ms=${duration} size=${this.config.dataSizeBytes} network=${this.config.network} retries=${this.config.maxRetries}`);

    return {
      uploadNum,
      success: false,
      error: 'Unknown error',
      duration,
    };
  }

  async start(): Promise<void> {
    if (!this.synapse) {
      await this.initialize();
    }

    log(`\nStarting ${this.config.parallelContexts} parallel contexts...\n`);

    const contextPromises: Promise<ContextResult>[] = [];

    for (let i = 0; i < this.config.parallelContexts; i++) {
      const contextId = i + 1;

      const promise = this.runContext(contextId).then((result) => {
        this.results.push(result);
        return result;
      });

      contextPromises.push(promise);

      if (i < this.config.parallelContexts - 1) {
        log(`[MAIN] Started context ${contextId}, waiting ${this.config.contextStartDelayMs}ms before next...`);
        await sleep(this.config.contextStartDelayMs);
      } else {
        log(`[MAIN] Started context ${contextId} (last)`);
      }
    }

    log(`\n[MAIN] All ${this.config.parallelContexts} contexts started, waiting for completion...\n`);

    await Promise.all(contextPromises);

    this.printResults();
  }

  printResults(): void {
    console.log('\n' + '='.repeat(80));
    console.log('                         PARALLEL CHAINTEST RESULTS');
    console.log('='.repeat(80));

    let totalUploads = 0;
    let successfulUploads = 0;

    const providerStats: Map<number | string, { success: number; fail: number; datasetIds: Set<number> }> = new Map();

    const getProviderId = (p: ProviderInfo | null) => p?.providerId ?? p?.id ?? 'unknown';

    for (const ctx of this.results) {
      const providerKey = getProviderId(ctx.provider);
      let ctxSuccesses = 0;
      let ctxTotal = 0;

      for (const round of ctx.rounds) {
        for (const upload of round.uploads) {
          ctxTotal++;
          totalUploads++;
          if (upload.success) {
            ctxSuccesses++;
            successfulUploads++;
          }
        }
      }

      const stats = providerStats.get(providerKey) ?? { success: 0, fail: 0, datasetIds: new Set() };
      stats.success += ctxSuccesses;
      stats.fail += ctxTotal - ctxSuccesses;
      if (ctx.datasetId) stats.datasetIds.add(ctx.datasetId);
      providerStats.set(providerKey, stats);

      const ctxDuration = ctx.endTime - ctx.startTime;

      console.log(`\nContext ${ctx.contextId}:`);
      console.log(`  Provider ID: ${getProviderId(ctx.provider)}`);
      console.log(`  Dataset ID: ${ctx.datasetId ?? 'none'} (existing: ${ctx.isExistingDataset})`);
      console.log(`  Uploads: ${ctxSuccesses}/${ctxTotal} successful`);
      console.log(`  Duration: ${formatDuration(ctxDuration)}`);

      for (const round of ctx.rounds) {
        console.log(`  Round ${round.roundNum}:`);
        for (const upload of round.uploads) {
          if (upload.success) {
            console.log(`    [U${upload.uploadNum}] OK: ${upload.pieceCid} (${formatDuration(upload.duration)})${upload.txHash ? ` TX: ${upload.txHash}` : ''}`);
          } else {
            console.log(`    [U${upload.uploadNum}] FAIL (${formatDuration(upload.duration)}): ${upload.error}`);
          }
        }
      }
    }

    console.log('\n' + '-'.repeat(80));
    console.log('PROVIDER SUMMARY:');
    console.log('-'.repeat(80));

    for (const [providerId, stats] of providerStats) {
      const total = stats.success + stats.fail;
      const rate = total > 0 ? ((stats.success / total) * 100).toFixed(1) : '0';
      console.log(`  Provider ${providerId}: ${stats.success}/${total} uploads (${rate}% success), datasets: [${Array.from(stats.datasetIds).join(', ')}]`);
    }

    console.log('\n' + '-'.repeat(80));
    console.log('OVERALL:');
    console.log('-'.repeat(80));
    console.log(`  Total contexts: ${this.results.length}`);
    console.log(`  Total uploads: ${successfulUploads}/${totalUploads} (${totalUploads > 0 ? ((successfulUploads / totalUploads) * 100).toFixed(1) : 0}% success)`);
    console.log(`  Unique providers: ${providerStats.size}`);
    console.log('=' .repeat(80) + '\n');
  }
}
