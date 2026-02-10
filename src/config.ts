import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export interface Config {
  privateKey: string;
  network: 'calibration' | 'mainnet';
  uploadIntervalSeconds: number;
  operationsPerRotation: number;
  dataSizeBytes: number;
  withCDN: boolean;
  maxUploads: number;
  maxRetries: number;
  retryDelayMs: number;
  // Parallel mode settings
  parallelContexts: number;      // Number of parallel contexts to spawn
  parallelUploads: number;       // Number of parallel uploads per round
  uploadsPerContext: number;     // Number of rounds per context
  contextStartDelayMs: number;   // Delay between starting each context
  excludeProviderIds: number[];  // Provider IDs to exclude from selection
  providerId?: number;           // Specific provider ID to use (optional)
  datasetId?: number;            // Existing dataset ID to upload into (optional)
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const privateKey = overrides.privateKey ?? process.env.PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('PRIVATE_KEY is required. Set it in .env or pass via CLI.');
  }

  const network = (overrides.network ?? process.env.NETWORK ?? 'calibration') as 'calibration' | 'mainnet';

  if (network !== 'calibration' && network !== 'mainnet') {
    throw new Error('NETWORK must be "calibration" or "mainnet"');
  }

  const dataSizeBytes = overrides.dataSizeBytes ?? parseInt(process.env.DATA_SIZE_BYTES ?? '1024', 10);

  if (dataSizeBytes < 127) {
    throw new Error('DATA_SIZE_BYTES must be at least 127 bytes (FOC minimum)');
  }

  return {
    privateKey,
    network,
    uploadIntervalSeconds: overrides.uploadIntervalSeconds ?? parseInt(process.env.UPLOAD_INTERVAL_SECONDS ?? '10', 10),
    operationsPerRotation: overrides.operationsPerRotation ?? parseInt(process.env.OPERATIONS_PER_ROTATION ?? '10', 10),
    dataSizeBytes,
    withCDN: overrides.withCDN ?? process.env.WITH_CDN === 'true',
    maxUploads: overrides.maxUploads ?? parseInt(process.env.MAX_UPLOADS ?? '0', 10),
    maxRetries: overrides.maxRetries ?? parseInt(process.env.MAX_RETRIES ?? '3', 10),
    retryDelayMs: overrides.retryDelayMs ?? parseInt(process.env.RETRY_DELAY_MS ?? '5000', 10),
    parallelContexts: overrides.parallelContexts ?? parseInt(process.env.PARALLEL_CONTEXTS ?? '1', 10),
    parallelUploads: overrides.parallelUploads ?? parseInt(process.env.PARALLEL_UPLOADS ?? '1', 10),
    uploadsPerContext: overrides.uploadsPerContext ?? parseInt(process.env.UPLOADS_PER_CONTEXT ?? '1', 10),
    contextStartDelayMs: overrides.contextStartDelayMs ?? parseInt(process.env.CONTEXT_START_DELAY_MS ?? '2000', 10),
    excludeProviderIds: overrides.excludeProviderIds ?? parseIntList(process.env.EXCLUDE_PROVIDER_IDS ?? ''),
    providerId: overrides.providerId ?? parseOptionalInt(process.env.PROVIDER_ID),
    datasetId: overrides.datasetId ?? parseOptionalInt(process.env.DATASET_ID),
  };
}

function parseIntList(str: string): number[] {
  if (!str.trim()) return [];
  return str.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

function parseOptionalInt(str: string | undefined): number | undefined {
  if (!str?.trim()) return undefined;
  const n = parseInt(str.trim(), 10);
  return isNaN(n) ? undefined : n;
}
