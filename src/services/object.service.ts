import { readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm';
import { storageService } from '../storage/storage.service.js';
import { metadataService } from '../metadata/metadata.service.js';
import { DATA_SHARDS, PARITY_SHARDS, TOTAL_SHARDS, NODE_NAMES } from '../config/constants.js';
import type { ObjectMetaData, ShardLocation } from '../models/object.model.js';

// Load and instantiate Reed-Solomon WASM synchronously
const wasmPath = path.resolve(process.cwd(), 'node_modules/@digitaldefiance/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const rs = ReedSolomonErasure.fromBytes(wasmBytes);

const divider   = '─'.repeat(60);
const thin      = '·'.repeat(60);

function log(msg: string) { console.log(msg); }

export class ObjectService {

  // ─── UPLOAD ────────────────────────────────────────────────────────────────
  async upload(fileName: string, mimeType: string, buffer: Buffer): Promise<string> {
    const id = uuidv4();

    log('');
    log(divider);
    log(`  ⬆  UPLOAD  →  ${fileName}  (${buffer.length} bytes)`);
    log(divider);

    // 1. Calculate padding and shard sizes
    const paddingSize = (DATA_SHARDS - (buffer.length % DATA_SHARDS)) % DATA_SHARDS;
    const paddedLength = buffer.length + paddingSize;
    const shardSize = paddedLength / DATA_SHARDS;

    log(`  📦 Original size : ${buffer.length} bytes`);
    log(`  🔧 Padding added : ${paddingSize} bytes  →  padded to ${paddedLength} bytes`);
    log(`  📐 Shard size    : ${shardSize} bytes each`);
    log(`  🔢 Config        : ${DATA_SHARDS} data shards  +  ${PARITY_SHARDS} parity shards  =  ${TOTAL_SHARDS} total`);
    log(thin);

    // 2. Prepare contiguous buffer for all shards (data + parity)
    const shards = new Uint8Array(shardSize * TOTAL_SHARDS);
    shards.set(buffer, 0);

    // 3. Generate parity shards via Reed-Solomon
    log('  ⚙️  Running Reed-Solomon encoding...');
    const result = rs.encode(shards, DATA_SHARDS, PARITY_SHARDS);
    if (result !== ReedSolomonErasure.RESULT_OK) {
      const err = new Error(`Reed-Solomon encoding failed with error code ${result}`);
      (err as any).statusCode = 500;
      throw err;
    }
    log('  ✅ Parity shards generated successfully');
    log(thin);

    // 4. Save each shard to its corresponding node directory
    log('  💾 Writing shards to storage nodes...');
    const shardLocations: ShardLocation[] = [];
    for (let i = 0; i < TOTAL_SHARDS; i++) {
      const nodeName = NODE_NAMES[i]!;
      const shardData = shards.subarray(i * shardSize, (i + 1) * shardSize);
      const type = i < DATA_SHARDS ? 'DATA  ' : 'PARITY';
      const filePath = await storageService.saveShard(nodeName, id, i, shardData);
      log(`     [${type}] shard ${i}  →  ${nodeName}/  (${shardData.length} bytes)`);
      shardLocations.push({ index: i, nodeName, path: filePath });
    }

    // 5. Save metadata
    const metadata: ObjectMetaData = {
      id, fileName, mimeType,
      size: buffer.length,
      paddingSize,
      createdAt: new Date().toISOString(),
      shards: shardLocations,
    };
    await metadataService.saveMetadata(metadata);

    log(thin);
    log(`  🆔 Object ID : ${id}`);
    log(`  📄 Metadata  : saved to metadata.json`);
    log(divider);
    log('');

    return id;
  }

  // ─── DOWNLOAD ──────────────────────────────────────────────────────────────
  async download(id: string): Promise<{ metadata: ObjectMetaData; buffer: Buffer }> {
    const metadata = await metadataService.getMetadata(id);
    if (!metadata) {
      const err = new Error(`Object with ID ${id} not found`);
      (err as any).statusCode = 404;
      throw err;
    }

    log('');
    log(divider);
    log(`  ⬇  DOWNLOAD  →  ${metadata.fileName}  (ID: ${id.slice(0, 8)}...)`);
    log(divider);

    const totalPaddedLength = metadata.size + metadata.paddingSize;
    const shardSize = totalPaddedLength / DATA_SHARDS;

    const shards = new Uint8Array(shardSize * TOTAL_SHARDS);
    const shardsAvailable = new Array<boolean>(TOTAL_SHARDS).fill(false);
    let availableCount = 0;

    // 1. Check and read all shards
    log('  🔍 Checking storage nodes...');
    log('');
    await Promise.all(
      metadata.shards.map(async (loc) => {
        const type   = loc.index < DATA_SHARDS ? 'DATA  ' : 'PARITY';
        const exists = await storageService.shardExists(loc.path);
        if (exists) {
          const shardData = await storageService.readShard(loc.path);
          shards.set(shardData, loc.index * shardSize);
          shardsAvailable[loc.index] = true;
          availableCount++;
          log(`     ✅  [${type}] shard ${loc.index}  ←  ${loc.nodeName}/  (${shardData.length} bytes)  PRESENT`);
        } else {
          log(`     ❌  [${type}] shard ${loc.index}  ←  ${loc.nodeName}/  MISSING — node offline or data lost`);
        }
      })
    );

    log('');
    log(thin);
    log(`  📊 Shards present : ${availableCount} / ${TOTAL_SHARDS}`);
    log(`  📊 Shards missing : ${TOTAL_SHARDS - availableCount} / ${TOTAL_SHARDS}`);
    log(`  📊 Minimum needed : ${DATA_SHARDS} (tolerance: lose up to ${PARITY_SHARDS})`);
    log(thin);

    // 2. Verify we have enough shards
    if (availableCount < DATA_SHARDS) {
      log(`  🚨 UNRECOVERABLE — only ${availableCount} shards available, need at least ${DATA_SHARDS}`);
      log(divider);
      log('');
      const err = new Error(`Cannot reconstruct object ${id}: only ${availableCount} shards available, need at least ${DATA_SHARDS}`);
      (err as any).statusCode = 500;
      throw err;
    }

    // 3. Reconstruct if any are missing
    if (availableCount < TOTAL_SHARDS) {
      const missing = TOTAL_SHARDS - availableCount;
      log(`  ⚙️  ${missing} shard(s) missing — running Reed-Solomon reconstruction...`);
      const result = rs.reconstruct(shards, DATA_SHARDS, PARITY_SHARDS, shardsAvailable);
      if (result !== ReedSolomonErasure.RESULT_OK) {
        log(`  🚨 Reconstruction FAILED with code ${result}`);
        log(divider);
        log('');
        const err = new Error(`Failed to reconstruct lost shards with error code ${result}`);
        (err as any).statusCode = 500;
        throw err;
      }
      log(`  ✅ Reconstruction SUCCESSFUL — all ${DATA_SHARDS} data shards recovered`);
    } else {
      log(`  ✅ All shards present — no reconstruction needed`);
    }

    // 4. Trim padding and return
    log(thin);
    log(`  ✂️  Removing ${metadata.paddingSize} padding bytes  →  original ${metadata.size} bytes`);
    log(`  📤 Returning file: ${metadata.fileName}`);
    log(divider);
    log('');

    const fileData = shards.subarray(0, metadata.size);
    return { metadata, buffer: Buffer.from(fileData) };
  }

  // ─── DELETE ────────────────────────────────────────────────────────────────
  async delete(id: string): Promise<void> {
    const metadata = await metadataService.getMetadata(id);
    if (!metadata) {
      const err = new Error(`Object with ID ${id} not found`);
      (err as any).statusCode = 404;
      throw err;
    }

    log('');
    log(divider);
    log(`  🗑  DELETE  →  ${metadata.fileName}  (ID: ${id.slice(0, 8)}...)`);
    log(divider);

    log('  💥 Deleting shards from all storage nodes...');
    await Promise.all(
      metadata.shards.map(async (loc) => {
        await storageService.deleteShard(loc.path);
        log(`     🗑  shard ${loc.index}  removed from  ${loc.nodeName}/`);
      })
    );

    await metadataService.deleteMetadata(id);
    log(thin);
    log('  📄 Metadata entry removed from metadata.json');
    log(divider);
    log('');
  }

  async list(): Promise<ObjectMetaData[]> {
    return await metadataService.listObjects();
  }
}

export const objectService = new ObjectService();
