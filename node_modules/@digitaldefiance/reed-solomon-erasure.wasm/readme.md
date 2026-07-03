# @digitaldefiance/reed-solomon-erasure.wasm

Reed-Solomon erasure coding compiled to WebAssembly. Works in both **browser** and **Node.js** environments.

This is a fork of [@subspace/reed-solomon-erasure.wasm](https://github.com/subspace/reed-solomon-erasure.wasm) with fixes for browser compatibility.

## Features

- ✅ Browser compatible (no `fs` dependency at module load)
- ✅ Node.js compatible
- ✅ TypeScript support with full type definitions
- ✅ ESM and CommonJS builds
- ✅ Async and sync instantiation methods

## Installation

```bash
npm install @digitaldefiance/reed-solomon-erasure.wasm
```

## Usage

### Browser

```typescript
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm';

// Load WASM asynchronously (recommended for browser)
const rs = await ReedSolomonErasure.fromResponse(
  fetch('/path/to/reed_solomon_erasure_bg.wasm')
);

// Or use auto-detection (works if WASM is in same directory as script)
const rs = await ReedSolomonErasure.fromCurrentDirectory();
```

### Node.js

```typescript
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm';

// Async loading (recommended)
const rs = await ReedSolomonErasure.fromCurrentDirectory();

// Or sync loading (Node.js only)
const rs = ReedSolomonErasure.fromCurrentDirectorySync();

// Or load from bytes
import { readFileSync } from 'fs';
const wasmBytes = readFileSync('./reed_solomon_erasure_bg.wasm');
const rs = ReedSolomonErasure.fromBytes(wasmBytes);
```

### Encoding (Creating Parity Shards)

```typescript
const dataShards = 4;
const parityShards = 2;
const shardSize = 1024; // bytes per shard
const totalShards = dataShards + parityShards;

// Create buffer for all shards (data + parity)
const shards = new Uint8Array(shardSize * totalShards);

// Fill data shards (first 4 shards) with your data
// shards[0..shardSize] = data shard 0
// shards[shardSize..shardSize*2] = data shard 1
// etc.

// Generate parity shards
const result = rs.encode(shards, dataShards, parityShards);

if (result === ReedSolomonErasure.RESULT_OK) {
  // Parity shards are now filled in (last 2 shards)
  console.log('Encoding successful!');
}
```

### Reconstruction (Recovering Lost Shards)

```typescript
// Simulate losing shards 1 and 2
const shardsAvailable = [true, false, false, true, true, true];

// Zero out the lost shards (or they may contain garbage)
// shards[shardSize..shardSize*3] = 0

const result = rs.reconstruct(shards, dataShards, parityShards, shardsAvailable);

if (result === ReedSolomonErasure.RESULT_OK) {
  // Data shards are now reconstructed!
  console.log('Reconstruction successful!');
}
```

## API Reference

### Static Methods

| Method | Description |
|--------|-------------|
| `fromCurrentDirectory()` | Auto-detect environment and load WASM from package directory |
| `fromCurrentDirectorySync()` | Synchronous loading (Node.js only) |
| `fromResponse(source)` | Load from fetch Response (browser) |
| `fromBytes(bytes)` | Load from raw WASM bytes |

### Instance Methods

| Method | Description |
|--------|-------------|
| `encode(shards, dataShards, parityShards)` | Generate parity shards |
| `reconstruct(shards, dataShards, parityShards, shardsAvailable)` | Reconstruct lost shards |

### Result Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `RESULT_OK` | 0 | Operation successful |
| `RESULT_ERROR_TOO_FEW_SHARDS` | 1 | Not enough shards provided |
| `RESULT_ERROR_TOO_MANY_SHARDS` | 2 | Too many shards provided |
| `RESULT_ERROR_TOO_FEW_SHARDS_PRESENT` | 10 | Not enough valid shards for reconstruction |
| ... | ... | See source for all error codes |

## Building from Source

Requires [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) for WASM compilation.

```bash
# Install dependencies
npm install

# Build (uses pre-compiled WASM)
npm run build

# Full build including WASM compilation
npm run build:full
```

## License

MIT - Based on work by Nazar Mokrynskyi and the Subspace team.

## Credits

- Original Rust implementation: [reed-solomon-erasure](https://github.com/rust-rse/reed-solomon-erasure)
- Original WASM wrapper: [@subspace/reed-solomon-erasure.wasm](https://github.com/subspace/reed-solomon-erasure.wasm)
