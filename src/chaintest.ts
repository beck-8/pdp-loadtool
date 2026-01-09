import { Synapse, RPC_URLS } from '@filoz/synapse-sdk';
import type { Config } from './config.js';
import { generateRandomData, formatBytes, formatDuration, log, logError, sleep } from './utils.js';

export interface ChaintestStats {
  totalUploads: number;
  successfulUploads: number;
  failedUploads: number;
  totalBytesUploaded: number;
  datasetsCreated: number;
  currentDatasetId: string | null;
  startTime: number;
  lastUploadTime: number | null;
  pieceCids: string[];
  totalRetries: number;
}

export interface ChaintestCallbacks {
  onUploadStart?: (uploadNumber: number) => void;
  onUploadSuccess?: (uploadNumber: number, pieceCid: string, duration: number) => void;
  onUploadError?: (uploadNumber: number, error: Error) => void;
  onDatasetCreated?: (datasetId: string, datasetNumber: number) => void;
  onRotation?: (newDatasetId: string, operationCount: number) => void;
  onStats?: (stats: ChaintestStats) => void;
  onRetry?: (attempt: number, maxRetries: number, error: Error) => void;
}

export class FOCChaintest {
  private config: Config;
  private synapse: Synapse | null = null;
  private stats: ChaintestStats;
  private callbacks: ChaintestCallbacks;
  private isRunning = false;
  private operationsSinceRotation = 0;
  private currentStorageContext: Awaited<ReturnType<Synapse['storage']['createContext']>> | null = null;
  private currentProviderId: number | null = null;
  private failedProviderIds: Set<number> = new Set();

  constructor(config: Config, callbacks: ChaintestCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.stats = {
      totalUploads: 0,
      successfulUploads: 0,
      failedUploads: 0,
      totalBytesUploaded: 0,
      datasetsCreated: 0,
      currentDatasetId: null,
      startTime: Date.now(),
      lastUploadTime: null,
      pieceCids: [],
      totalRetries: 0,
    };
  }

  /**
   * Retry wrapper with exponential backoff
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          // Exponential backoff: delay * 2^(attempt-1)
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          log(`${operationName} failed (attempt ${attempt}/${this.config.maxRetries}): ${lastError.message}`);
          log(`Retrying in ${formatDuration(delay)}...`);
          this.stats.totalRetries++;
          this.callbacks.onRetry?.(attempt, this.config.maxRetries, lastError);
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  async initialize(): Promise<void> {
    log('Initializing FOC Chaintest...');
    log(`Network: ${this.config.network}`);
    log(`Upload interval: ${this.config.uploadIntervalSeconds}s`);
    log(`Data size: ${formatBytes(this.config.dataSizeBytes)}`);
    log(`Operations per rotation: ${this.config.operationsPerRotation || 'disabled'}`);
    log(`Max uploads: ${this.config.maxUploads || 'unlimited'}`);
    log(`Max retries: ${this.config.maxRetries} (initial delay: ${this.config.retryDelayMs}ms)`);

    const rpcUrl = this.config.network === 'mainnet'
      ? RPC_URLS.mainnet.http
      : RPC_URLS.calibration.http;

    this.synapse = await Synapse.create({
      privateKey: this.config.privateKey,
      rpcURL: rpcUrl,
      withCDN: this.config.withCDN,
      telemetry: { sentryInitOptions: { enabled: true } },
    });

    log('Synapse SDK initialized');
    const signer = this.synapse.getSigner();
    const address = await signer.getAddress();
    log(`Wallet address: ${address}`);

    // Create initial storage context (creates first dataset) with retry
    await this.createNewStorageContext();
  }

  private async createNewStorageContext(excludeProviders?: number[]): Promise<void> {
    if (!this.synapse) throw new Error('Synapse not initialized');

    const excludeList = excludeProviders || Array.from(this.failedProviderIds);
    if (excludeList.length > 0) {
      log(`Creating new storage context (excluding providers: ${excludeList.join(', ')})...`);
    } else {
      log('Creating new storage context and dataset...');
    }

    let resolvedProviderId: number | null = null;

    await this.withRetry(async () => {
      this.currentStorageContext = await this.synapse!.storage.createContext({
        forceCreateDataSet: true,
        excludeProviderIds: excludeList.length > 0 ? excludeList : undefined,
        callbacks: {
          onDataSetResolved: (info) => {
            const dataSetIdStr = String(info.dataSetId);
            log(`Dataset resolved: ${dataSetIdStr} (existing: ${info.isExisting})`);
            if (!info.isExisting) {
              this.stats.datasetsCreated++;
              this.callbacks.onDatasetCreated?.(dataSetIdStr, this.stats.datasetsCreated);
            }
            this.stats.currentDatasetId = dataSetIdStr;
            // Extract provider ID from dataset info if available
            if ('providerId' in info && typeof info.providerId === 'number') {
              resolvedProviderId = info.providerId;
              log(`Provider: ${info.providerId}`);
            }
          },
        },
      });
    }, 'Create storage context');

    this.currentProviderId = resolvedProviderId;
    this.operationsSinceRotation = 0;
    log('Storage context ready');
  }

  private async rotateDatasetIfNeeded(): Promise<void> {
    if (this.config.operationsPerRotation <= 0) return;

    if (this.operationsSinceRotation >= this.config.operationsPerRotation) {
      log(`Rotation threshold reached (${this.operationsSinceRotation} operations)`);
      const oldDatasetId = this.stats.currentDatasetId;
      await this.createNewStorageContext();
      this.callbacks.onRotation?.(this.stats.currentDatasetId!, this.operationsSinceRotation);
      log(`Rotated from dataset ${oldDatasetId} to ${this.stats.currentDatasetId}`);
    }
  }

  private isPdpError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes('pdp') || msg.includes('timeout') || msg.includes('failed to find piece');
  }

  private async uploadOnce(): Promise<void> {
    if (!this.synapse || !this.currentStorageContext) {
      throw new Error('Chaintest not initialized');
    }

    this.stats.totalUploads++;
    const uploadNumber = this.stats.totalUploads;

    this.callbacks.onUploadStart?.(uploadNumber);
    log(`Starting upload #${uploadNumber}...`);

    const startTime = Date.now();
    const data = generateRandomData(this.config.dataSizeBytes);

    let lastError: Error | null = null;
    let success = false;

    for (let attempt = 1; attempt <= this.config.maxRetries && !success; attempt++) {
      try {
        const result = await this.currentStorageContext!.upload(data);

        const duration = Date.now() - startTime;
        this.stats.successfulUploads++;
        this.stats.totalBytesUploaded += this.config.dataSizeBytes;
        this.stats.lastUploadTime = Date.now();

        // Clear failed providers on success
        this.failedProviderIds.clear();

        const pieceCidStr = String(result.pieceCid);
        this.stats.pieceCids.push(pieceCidStr);
        this.operationsSinceRotation++;

        log(`Upload #${uploadNumber} successful: ${pieceCidStr} (${formatDuration(duration)})`);
        this.callbacks.onUploadSuccess?.(uploadNumber, pieceCidStr, duration);
        success = true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          this.stats.totalRetries++;
          this.callbacks.onRetry?.(attempt, this.config.maxRetries, lastError);

          // On PDP/timeout errors, try switching to a different provider
          if (this.isPdpError(lastError) && this.currentProviderId !== null) {
            log(`Upload #${uploadNumber} failed (attempt ${attempt}/${this.config.maxRetries}): ${lastError.message}`);
            log(`PDP error detected - switching to different provider...`);
            this.failedProviderIds.add(this.currentProviderId);
            try {
              await this.createNewStorageContext();
              log(`Switched to provider ${this.currentProviderId}`);
            } catch (contextError) {
              log(`Failed to switch provider: ${contextError instanceof Error ? contextError.message : contextError}`);
              // Fall back to exponential backoff
              const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
              log(`Retrying in ${formatDuration(delay)}...`);
              await sleep(delay);
            }
          } else {
            // Regular retry with exponential backoff
            const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
            log(`Upload #${uploadNumber} failed (attempt ${attempt}/${this.config.maxRetries}): ${lastError.message}`);
            log(`Retrying in ${formatDuration(delay)}...`);
            await sleep(delay);
          }
        }
      }
    }

    if (!success && lastError) {
      this.stats.failedUploads++;
      logError(`Upload #${uploadNumber} failed after ${this.config.maxRetries} attempts: ${lastError.message}`);
      this.callbacks.onUploadError?.(uploadNumber, lastError);
    }

    this.callbacks.onStats?.(this.getStats());
  }

  async start(): Promise<void> {
    if (!this.synapse) {
      await this.initialize();
    }

    this.isRunning = true;
    log('Starting chaintest loop...');

    while (this.isRunning) {
      // Check if we've reached max uploads
      if (this.config.maxUploads > 0 && this.stats.successfulUploads >= this.config.maxUploads) {
        log(`Reached max uploads (${this.config.maxUploads}), stopping...`);
        break;
      }

      // Check for dataset rotation
      await this.rotateDatasetIfNeeded();

      // Perform upload
      await this.uploadOnce();

      // Wait for next interval
      if (this.isRunning) {
        log(`Waiting ${this.config.uploadIntervalSeconds}s before next upload...`);
        await sleep(this.config.uploadIntervalSeconds * 1000);
      }
    }

    this.printFinalStats();
  }

  stop(): void {
    log('Stopping chaintest...');
    this.isRunning = false;
  }

  getStats(): ChaintestStats {
    return { ...this.stats };
  }

  printFinalStats(): void {
    const duration = Date.now() - this.stats.startTime;
    console.log('\n========== CHAINTEST RESULTS ==========');
    console.log(`Duration: ${formatDuration(duration)}`);
    console.log(`Total uploads attempted: ${this.stats.totalUploads}`);
    console.log(`Successful uploads: ${this.stats.successfulUploads}`);
    console.log(`Failed uploads: ${this.stats.failedUploads}`);
    console.log(`Success rate: ${((this.stats.successfulUploads / this.stats.totalUploads) * 100).toFixed(1)}%`);
    console.log(`Total data uploaded: ${formatBytes(this.stats.totalBytesUploaded)}`);
    console.log(`Datasets created: ${this.stats.datasetsCreated}`);
    console.log(`Total retries: ${this.stats.totalRetries}`);
    console.log(`Avg upload rate: ${(this.stats.successfulUploads / (duration / 1000)).toFixed(2)} uploads/sec`);
    console.log('========================================\n');
  }
}
