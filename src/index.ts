#!/usr/bin/env node

import { Command } from 'commander';
import { ethers } from 'ethers';
import { Synapse, RPC_URLS } from '@filoz/synapse-sdk';
import { loadConfig } from './config.js';
import { FOCChaintest } from './chaintest.js';
import { ParallelChaintest } from './parallel.js';
import { log, formatBytes, formatDuration } from './utils.js';

// Suppress SDK internal timeout errors (unhandled AbortController rejections)
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    // Silently ignore SDK internal timeout aborts
    return;
  }
  console.error('Unhandled rejection:', reason);
});

const program = new Command();

program
  .name('foc-chaintest')
  .description('Filecoin Onchain Cloud chaintest - uploads data periodically with configurable rotation')
  .version('1.0.0')
  .option('-k, --private-key <key>', 'Wallet private key (or set PRIVATE_KEY env var)')
  .option('-n, --network <network>', 'Network: calibration or mainnet')
  .option('-i, --interval <seconds>', 'Upload interval in seconds')
  .option('-r, --rotation <count>', 'Operations before dataset/payment rail rotation (0=disabled)')
  .option('-s, --size <bytes>', 'Data size in bytes (min 127)')
  .option('-c, --cdn', 'Enable CDN for faster retrieval')
  .option('-m, --max <count>', 'Maximum number of uploads (0=unlimited)')
  .option('--retries <count>', 'Max retries per operation')
  .option('--retry-delay <ms>', 'Initial retry delay in ms (doubles each retry)')
  .option('--verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    try {
      const parseIntOpt = (val: string | undefined) => val ? parseInt(val, 10) : undefined;

      const config = loadConfig({
        privateKey: options.privateKey,
        network: options.network as 'calibration' | 'mainnet',
        uploadIntervalSeconds: parseIntOpt(options.interval),
        operationsPerRotation: parseIntOpt(options.rotation),
        dataSizeBytes: parseIntOpt(options.size),
        withCDN: options.cdn,
        maxUploads: parseIntOpt(options.max),
        maxRetries: parseIntOpt(options.retries),
        retryDelayMs: parseIntOpt(options.retryDelay),
      });

      console.log(`
╔═══════════════════════════════════════════════════════════╗
║           FOC Chaintest - Filecoin Onchain Cloud          ║
╚═══════════════════════════════════════════════════════════╝
`);

      const chaintest = new FOCChaintest(config, {
        onUploadStart: (num) => {
          if (options.verbose) {
            log(`[VERBOSE] Preparing upload #${num}`);
          }
        },
        onUploadSuccess: (num, pieceCid, duration) => {
          log(`Upload #${num} complete: ${pieceCid.slice(0, 20)}... (${formatDuration(duration)})`);
        },
        onUploadError: (num, error) => {
          log(`Upload #${num} failed: ${error.message}`);
        },
        onDatasetCreated: (datasetId, datasetNumber) => {
          log(`Dataset #${datasetNumber} created: ${datasetId}`);
        },
        onRotation: (newDatasetId, opCount) => {
          log(`Rotated to new dataset after ${opCount} operations`);
        },
        onRetry: (attempt, maxRetries, error) => {
          log(`Retry ${attempt}/${maxRetries} after error: ${error.message.slice(0, 100)}...`);
        },
        onStats: (stats) => {
          if (options.verbose && stats.totalUploads % 5 === 0) {
            console.log(`\n--- Stats Update ---`);
            console.log(`Uploads: ${stats.successfulUploads}/${stats.totalUploads}`);
            console.log(`Data: ${formatBytes(stats.totalBytesUploaded)}`);
            console.log(`Datasets: ${stats.datasetsCreated}`);
            console.log(`Retries: ${stats.totalRetries}`);
            console.log(`-------------------\n`);
          }
        },
      });

      // Handle graceful shutdown
      const shutdown = () => {
        log('\nShutdown signal received...');
        chaintest.stop();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await chaintest.start();

    } catch (error) {
      console.error('Fatal error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Setup command - deposit funds
program
  .command('setup')
  .description('Deposit USDFC (required before first upload)')
  .option('-k, --private-key <key>', 'Wallet private key')
  .option('-n, --network <network>', 'Network: calibration or mainnet')
  .option('-a, --amount <usdfc>', 'Amount of USDFC to deposit', '2.5')
  .action(async (options) => {
    try {
      const config = loadConfig({
        privateKey: options.privateKey,
        network: options.network as 'calibration' | 'mainnet',
      });

      log('Setting up FOC account...');

      const rpcUrl = config.network === 'mainnet'
        ? RPC_URLS.mainnet.http
        : RPC_URLS.calibration.http;

      const synapse = await Synapse.create({
        privateKey: config.privateKey,
        rpcURL: rpcUrl,
      });

      const signer = synapse.getSigner();
      const address = await signer.getAddress();
      log(`Wallet address: ${address}`);
      log(`Network: ${config.network}`);
      log(`Warm Storage: ${synapse.getWarmStorageAddress()}`);

      // Check current account info
      log('Checking account info...');
      try {
        const accountInfo = await synapse.payments.accountInfo();
        log(`Current funds: ${ethers.formatUnits(accountInfo.funds, 18)} USDFC`);
        log(`Available funds: ${ethers.formatUnits(accountInfo.availableFunds, 18)} USDFC`);
      } catch (e) {
        log('No existing account found, will create one.');
      }

      const depositAmount = ethers.parseUnits(options.amount, 18);
      log(`Depositing ${options.amount} USDFC...`);

      const tx = await synapse.payments.deposit(depositAmount);

      log(`Transaction submitted: ${tx.hash}`);
      log('Waiting for confirmation...');

      await tx.wait();

      log('Deposit complete!');

      // Show updated account info
      const updatedInfo = await synapse.payments.accountInfo();
      console.log('\nAccount Info:');
      console.log('-'.repeat(40));
      console.log(`Funds: ${ethers.formatUnits(updatedInfo.funds, 18)} USDFC`);
      console.log(`Available: ${ethers.formatUnits(updatedInfo.availableFunds, 18)} USDFC`);
      console.log('-'.repeat(40));

      console.log('\nNote: If uploads fail with "recordKeeper address not allowed",');
      console.log('your address may need to be whitelisted on the testnet service.');

    } catch (error) {
      console.error('Setup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Add subcommand for single upload
program
  .command('single')
  .description('Perform a single upload')
  .option('-k, --private-key <key>', 'Wallet private key')
  .option('-n, --network <network>', 'Network: calibration or mainnet')
  .option('-s, --size <bytes>', 'Data size in bytes')
  .option('-c, --cdn', 'Enable CDN')
  .option('--retries <count>', 'Max retries per operation')
  .option('--retry-delay <ms>', 'Initial retry delay in ms')
  .action(async (options) => {
    try {
      const parseIntOpt = (val: string | undefined) => val ? parseInt(val, 10) : undefined;

      const config = loadConfig({
        privateKey: options.privateKey,
        network: options.network as 'calibration' | 'mainnet',
        uploadIntervalSeconds: 0,
        operationsPerRotation: 0,
        dataSizeBytes: parseIntOpt(options.size),
        withCDN: options.cdn,
        maxUploads: 1,
        maxRetries: parseIntOpt(options.retries),
        retryDelayMs: parseIntOpt(options.retryDelay),
      });

      log('Performing single upload...');

      const chaintest = new FOCChaintest(config, {
        onUploadSuccess: (_, pieceCid, duration) => {
          console.log(`\nUpload successful!`);
          console.log(`  PieceCID: ${pieceCid}`);
          console.log(`  Duration: ${formatDuration(duration)}`);
          console.log(`  Size: ${formatBytes(config.dataSizeBytes)}`);
        },
        onUploadError: (_, error) => {
          console.error(`\nUpload failed: ${error.message}`);
        },
        onRetry: (attempt, maxRetries, error) => {
          log(`Retry ${attempt}/${maxRetries} after error: ${error.message.slice(0, 100)}...`);
        },
      });

      await chaintest.start();

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Add info command
program
  .command('info')
  .description('Show configuration info without running')
  .action(() => {
    try {
      const config = loadConfig();
      console.log('\nCurrent Configuration:');
      console.log('-'.repeat(40));
      console.log(`Network:              ${config.network}`);
      console.log(`Upload interval:      ${config.uploadIntervalSeconds}s`);
      console.log(`Data size:            ${formatBytes(config.dataSizeBytes)}`);
      console.log(`Rotation threshold:   ${config.operationsPerRotation || 'disabled'}`);
      console.log(`CDN enabled:          ${config.withCDN}`);
      console.log(`Max uploads:          ${config.maxUploads || 'unlimited'}`);
      console.log(`Max retries:          ${config.maxRetries}`);
      console.log(`Retry delay:          ${config.retryDelayMs}ms`);
      console.log(`Private key:          ${config.privateKey ? '****' + config.privateKey.slice(-4) : 'NOT SET'}`);
      console.log('-'.repeat(40));
    } catch (error) {
      console.error('Error loading config:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Balance command
program
  .command('balance')
  .description('Check account balance and approvals')
  .option('-k, --private-key <key>', 'Wallet private key')
  .option('-n, --network <network>', 'Network: calibration or mainnet')
  .action(async (options) => {
    try {
      const config = loadConfig({
        privateKey: options.privateKey,
        network: options.network as 'calibration' | 'mainnet',
      });

      const rpcUrl = config.network === 'mainnet'
        ? RPC_URLS.mainnet.http
        : RPC_URLS.calibration.http;

      const synapse = await Synapse.create({
        privateKey: config.privateKey,
        rpcURL: rpcUrl,
      });

      const signer = synapse.getSigner();
      const address = await signer.getAddress();

      console.log('\nAccount Information:');
      console.log('-'.repeat(40));
      console.log(`Address: ${address}`);
      console.log(`Network: ${config.network}`);

      // Get wallet balances
      try {
        const filBalance = await synapse.payments.walletBalance();
        console.log(`FIL Balance: ${ethers.formatUnits(filBalance, 18)} FIL`);
      } catch (e) {
        // ignore
      }

      try {
        const usdfcBalance = await synapse.payments.walletBalance('USDFC');
        console.log(`USDFC Wallet: ${ethers.formatUnits(usdfcBalance, 18)} USDFC`);
      } catch (e) {
        // ignore
      }

      try {
        const accountInfo = await synapse.payments.accountInfo();
        console.log(`FOC Funds: ${ethers.formatUnits(accountInfo.funds, 18)} USDFC`);
        console.log(`FOC Available: ${ethers.formatUnits(accountInfo.availableFunds, 18)} USDFC`);
      } catch (e) {
        console.log('FOC Account: Not found (run setup first)');
      }

      console.log('-'.repeat(40));

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parallel upload command for debugging provider behavior
program
  .command('parallel')
  .description('Run parallel uploads with multiple contexts (for debugging provider behavior)')
  .option('-k, --private-key <key>', 'Wallet private key')
  .option('-n, --network <network>', 'Network: calibration or mainnet')
  .option('-p, --contexts <count>', 'Number of parallel contexts to spawn')
  .option('-u, --uploads <count>', 'Number of parallel uploads per round')
  .option('-R, --rounds <count>', 'Number of rounds per context')
  .option('-d, --delay <ms>', 'Delay between starting each context (ms)')
  .option('-s, --size <bytes>', 'Data size in bytes')
  .option('-c, --cdn', 'Enable CDN')
  .option('--retries <count>', 'Max retries per upload')
  .option('--retry-delay <ms>', 'Initial retry delay in ms')
  .option('-i, --interval <seconds>', 'Seconds between starting each round (rounds overlap)')
  .option('-x, --exclude <ids>', 'Comma-separated list of provider IDs to exclude')
  .option('--provider <id>', 'Specific provider ID to use')
  .action(async (options, command) => {
    try {
      // Helper to get option from subcommand or global args (without defaults masking fallback)
      const getOpt = (key: string) => options[key] ?? command.parent?.opts()[key];
      const parseIntOpt = (val: string | undefined) => val ? parseInt(val, 10) : undefined;

      const excludeProviderIds = options.exclude
        ? options.exclude.split(',').map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n))
        : [];

      const providerId = options.provider ? parseInt(options.provider, 10) : undefined;

      // Check global network too using getOpt logic manually since network has CLI default 'calibration' handling in loadConfig
      const networkOpt = options.network ?? command.parent?.opts().network;

      const config = loadConfig({
        privateKey: options.privateKey, // Private key doesn't clash usually
        network: networkOpt as 'calibration' | 'mainnet',
        parallelContexts: parseIntOpt(options.contexts),
        parallelUploads: parseIntOpt(options.uploads),
        uploadsPerContext: parseIntOpt(options.rounds),
        contextStartDelayMs: parseIntOpt(options.delay),
        dataSizeBytes: parseIntOpt(getOpt('size')),
        withCDN: getOpt('cdn'),
        maxRetries: parseIntOpt(getOpt('retries')),
        retryDelayMs: parseIntOpt(getOpt('retryDelay')),
        uploadIntervalSeconds: parseIntOpt(getOpt('interval')), // parallel specific interval (-i) overrides global
        excludeProviderIds,
        providerId,
      });

      console.log(`
╔═══════════════════════════════════════════════════════════╗
║        FOC Parallel Chaintest - Provider Debugging        ║
╚═══════════════════════════════════════════════════════════╝
`);

      const parallel = new ParallelChaintest(config);

      // Handle graceful shutdown
      const shutdown = () => {
        log('\nShutdown signal received...');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await parallel.start();

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
