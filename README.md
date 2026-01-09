# FOC Chaintest

A testing and benchmarking tool for [Filecoin Onchain Cloud](https://docs.filecoin.cloud/) (FOC). Performs periodic uploads to test FOC infrastructure, debug provider behavior, and stress test the network.

## Features

- **Continuous Upload Testing**: Upload data at configurable intervals
- **Parallel Upload Mode**: Debug provider behavior under concurrent load
- **Dataset Rotation**: Create new datasets/payment rails every N operations
- **Automatic Retry**: Exponential backoff with provider failover
- **Provider Selection**: Target or exclude specific providers
- **Statistics Tracking**: Real-time progress and detailed reporting
- **Docker Support**: Easy deployment with Docker Compose

## Prerequisites

- Docker and Docker Compose (recommended) OR Node.js 18+
- A wallet with:
  - **Calibration testnet**: tFIL and test USDFC
  - **Mainnet**: FIL and USDFC tokens

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env and set PRIVATE_KEY (without 0x prefix)
```

### 2. Set Up FOC Account

```bash
docker compose run --rm setup
```

### 3. Run Chaintest

```bash
docker compose up --build foc-chaintest
```

## Commands

| Command | Description |
|---------|-------------|
| (default) | Run continuous chaintest |
| `setup` | Initialize FOC account with USDFC deposit |
| `single` | Perform a single test upload |
| `balance` | Check wallet and FOC account balances |
| `info` | Display current configuration |
| `parallel` | Run parallel uploads for provider debugging |

### Using Docker Compose

```bash
# Continuous chaintest
docker compose up --build foc-chaintest

# Single upload test
docker compose run --rm single

# Check balances
docker compose run --rm balance

# Show configuration
docker compose run --rm info

# Development mode with live reload
docker compose up --build dev
```

### Using Node.js

```bash
npm install
npm run build
node dist/index.js [command] [options]

# Or in development:
npm run dev -- [command] [options]
```

## Parallel Mode

The parallel command is designed for debugging provider behavior under concurrent load. It spawns multiple contexts, each performing rounds of parallel uploads.

### Basic Usage

```bash
docker compose run --rm parallel node dist/index.js parallel \
  --contexts 1 \
  --uploads 10 \
  --rounds 10 \
  --delay 5000 \
  --interval 100 \
  --provider 2
```

### Parallel Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--contexts` | `-p` | 10 | Number of parallel contexts to spawn |
| `--uploads` | `-u` | 3 | Parallel uploads per round |
| `--rounds` | `-R` | 3 | Number of rounds per context |
| `--interval` | `-i` | 15 | Seconds between round starts |
| `--delay` | `-d` | 2000 | Delay (ms) between context starts |
| `--provider` | | | Force specific provider ID |
| `--exclude` | `-x` | | Exclude provider IDs (comma-separated) |

### Examples

**Single context, high concurrency:**
```bash
docker compose run --rm parallel node dist/index.js parallel \
  --contexts 1 --uploads 10 --rounds 10 --delay 5000 --interval 100 --provider 2
```

**Multiple contexts, moderate load:**
```bash
docker compose run --rm parallel node dist/index.js parallel \
  --contexts 5 --uploads 3 --rounds 5 --interval 10
```

**Exclude problematic providers:**
```bash
docker compose run --rm parallel node dist/index.js parallel \
  --contexts 3 --uploads 5 --rounds 3 --exclude 1,4,7
```

## Configuration

### CLI Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--private-key` | `-k` | env | Wallet private key (required) |
| `--network` | `-n` | calibration | Network: `calibration` or `mainnet` |
| `--interval` | `-i` | 10 | Upload interval in seconds |
| `--rotation` | `-r` | 10 | Operations before dataset rotation (0=disabled) |
| `--size` | `-s` | 1024 | Data size in bytes (min: 127) |
| `--cdn` | `-c` | false | Enable CDN for faster retrieval |
| `--max` | `-m` | 0 | Max uploads (0=unlimited) |
| `--retries` | | 3 | Max retries per operation |
| `--retry-delay` | | 5000 | Initial retry delay in ms |
| `--verbose` | | false | Enable verbose logging |

### Environment Variables

Set in `.env` file:

```bash
# Required
PRIVATE_KEY=your_private_key_without_0x_prefix

# Network
NETWORK=calibration              # or mainnet

# Continuous mode settings
UPLOAD_INTERVAL_SECONDS=10
OPERATIONS_PER_ROTATION=10
DATA_SIZE_BYTES=1024
WITH_CDN=false
MAX_UPLOADS=0                    # 0 = unlimited
MAX_RETRIES=3
RETRY_DELAY_MS=5000

# Parallel mode settings
PARALLEL_CONTEXTS=1
PARALLEL_UPLOADS=1
UPLOADS_PER_CONTEXT=1
CONTEXT_START_DELAY_MS=2000
EXCLUDE_PROVIDER_IDS=            # comma-separated
PROVIDER_ID=                     # specific provider to use
```

## Docker Compose Services

| Service | Command | Description |
|---------|---------|-------------|
| `foc-chaintest` | `node dist/index.js` | Main chaintest runner |
| `dev` | `npx tsx watch src/index.ts` | Live reload development |
| `setup` | `node dist/index.js setup` | Account initialization |
| `balance` | `node dist/index.js balance` | Check balances |
| `single` | `node dist/index.js single` | Single upload test |
| `info` | `node dist/index.js info` | Show configuration |
| `parallel` | `node dist/index.js parallel` | Parallel upload testing |

## Test Scenarios

### Basic Continuous Testing
```bash
docker compose up --build foc-chaintest
```

### High-Frequency Stress Test
```bash
docker compose run --rm foc-chaintest node dist/index.js \
  --interval 2 --rotation 50 --max 500
```

### Provider Debugging
```bash
docker compose run --rm parallel node dist/index.js parallel \
  --contexts 1 --uploads 10 --rounds 10 --delay 5000 --interval 100 --provider 2
```

### Mainnet Testing (use with caution)
```bash
docker compose run --rm foc-chaintest node dist/index.js \
  --network mainnet --interval 60 --max 5
```

## Error Handling

- **Automatic Retries**: Exponential backoff (delay × 2^attempt)
- **PDP Error Detection**: Switches providers on PDP/timeout errors
- **Provider Blacklisting**: Failed providers excluded from subsequent contexts

## Example Output

```
╔═══════════════════════════════════════════════════════════╗
║           FOC Chaintest - Filecoin Onchain Cloud          ║
╚═══════════════════════════════════════════════════════════╝

[2026-01-09T10:30:00.000Z] Initializing FOC Chaintest...
[2026-01-09T10:30:00.001Z] Network: calibration
[2026-01-09T10:30:00.002Z] Upload interval: 10s
[2026-01-09T10:30:02.000Z] Dataset #1 created: ds-abc123...
[2026-01-09T10:30:02.500Z] Upload #1 complete: bafkzcib... (1.2s)
...

========== CHAINTEST RESULTS ==========
Duration: 5m 30s
Total uploads attempted: 33
Successful uploads: 32
Failed uploads: 1
Success rate: 97.0%
Total data uploaded: 32 KB
Datasets created: 4
========================================
```

## Building

```bash
npm install
npm run build    # Compile TypeScript to dist/
npm run dev      # Run directly with tsx
npm start        # Run compiled version
```

## Architecture

```
src/
├── index.ts        # CLI entry point (Commander.js)
├── config.ts       # Configuration loading
├── chaintest.ts    # Sequential chaintest logic
├── parallel.ts     # Parallel upload logic
└── utils.ts        # Helper functions
```

## License

MIT
