import { randomBytes } from 'crypto';

/**
 * Generate random data of specified size
 */
export function generateRandomData(sizeBytes: number): Uint8Array {
  return new Uint8Array(randomBytes(sizeBytes));
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a timestamp string for logging
 */
export function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Log with timestamp prefix
 */
export function log(message: string, ...args: unknown[]): void {
  console.log(`[${timestamp()}] ${message}`, ...args);
}

/**
 * Log error with timestamp prefix
 */
export function logError(message: string, ...args: unknown[]): void {
  console.error(`[${timestamp()}] ERROR: ${message}`, ...args);
}
