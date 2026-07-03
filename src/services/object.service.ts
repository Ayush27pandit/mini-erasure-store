import { readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm';
import { storageService } from '../storage/storage.service.js';
import { metadataService } from '../metadata/metadata.service.js';
import { DATA_SHARDS, PARITY_SHARDS, TOTAL_SHARDS, NODE_NAMES } from '../config/constants.js';
import type { ObjectMetaData, ShardLocation } from '../models/object.model.js';

const wasmPath = path.resolve(process.cwd(), 'node_modules/@digitaldefiance/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const rs = ReedSolomonErasure.fromBytes(wasmBytes);

const divider   = '─'.repeat(60);
const thin      = '·'.repeat(60);

function log(msg: string) { console.log(msg); }

function ensureShardId(shards: ShardLocation[], objectId: string): ShardLocation[] {
  return shards.map(s => ({ ...s, objectId: s.objectId || objectId }));
}

export class ObjectService {

  // ─── UPLOAD ────────────────────────────────────────────────────────────────
  async upload(fileName: string, mimeType: string, buffer: Buffer): Promise<string> {
    const id = uuidv4();

    log('');
    log(divider);
    log(`  ⬆  UPLOAD  →  ${fileName}  (${buffer.length} bytes)`);
    log(divider);

    const paddingSize = (DATA_SHARDS - (buffer.length % DATA_SHARDS)) % DATA_SHARDS;
    const paddedLength = buffer.length + paddingSize;
    const shardSize = paddedLength / DATA_SHARDS;

    log(`  📦 Original size : ${buffer.length} bytes`);
    log(`  🔧 Padding added : ${paddingSize} bytes  →  padded to ${paddedLength} bytes`);
    log(`  📐 Shard size    : ${shardSize} bytes each`);
    log(`  🔢 Config        : ${DATA_SHARDS} data shards  +  ${PARITY_SHARDS} parity shards  =  ${TOTAL_SHARDS} total`);
    log(thin);

    const shards = new Uint8Array(shardSize * TOTAL_SHARDS);
    shards.set(buffer, 0);

    log('  ⚙️  Running Reed-Solomon encoding...');
    const result = rs.encode(shards, DATA_SHARDS, PARITY_SHARDS);
    if (result !== ReedSolomonErasure.RESULT_OK) {
      const err = new Error(`Reed-Solomon encoding failed with error code ${result}`);
      (err as any).statusCode = 500;
      throw err;
    }
    log('  ✅ Parity shards generated successfully');
    log(thin);

    log('  💾 Writing shards to storage nodes...');
    log(`     🌐 Target: 6 storage nodes on ports ${3001}–${3000 + TOTAL_SHARDS}`);
    const shardLocations: ShardLocation[] = [];
    for (let i = 0; i < TOTAL_SHARDS; i++) {
      const nodeName = NODE_NAMES[i]!;
      const shardData = shards.subarray(i * shardSize, (i + 1) * shardSize);
      const type = i < DATA_SHARDS ? 'DATA  ' : 'PARITY';
      const { path: filePath, hash } = await storageService.saveShard(nodeName, id, i, shardData);
      log(`     [${type}] shard ${i}  →  ${nodeName}/  hash=${hash.slice(0, 8)}...`);
      shardLocations.push({
        index: i,
        nodeName,
        path: filePath,
        hash,
        objectId: id,
      });
    }

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
    log(`  📄 Metadata  : saved to metadata.json (with SHA-256 hashes)`);
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

    const shardsBuf = new Uint8Array(shardSize * TOTAL_SHARDS);
    const shardsAvailable = new Array<boolean>(TOTAL_SHARDS).fill(false);
    let availableCount = 0;

    log('  🔍 Fetching shards from storage nodes...');
    log('');

    const shardLocs = ensureShardId(metadata.shards, metadata.id);

    await Promise.all(
      shardLocs.map(async (loc) => {
        const type   = loc.index < DATA_SHARDS ? 'DATA  ' : 'PARITY';
        try {
          const shardData = await storageService.readShard(loc);
          if (shardData) {
            shardsBuf.set(shardData, loc.index * shardSize);
            shardsAvailable[loc.index] = true;
            availableCount++;
            log(`     ✅  [${type}] shard ${loc.index}  ←  ${loc.nodeName}/  (${shardData.length} bytes)  PRESENT  hash=${loc.hash.slice(0, 8)}...`);
          } else {
            log(`     ❌  [${type}] shard ${loc.index}  ←  ${loc.nodeName}/  MISSING or CORRUPT`);
          }
        } catch (err) {
          log(`     ❌  [${type}] shard ${loc.index}  ←  ${loc.nodeName}/  ERROR: ${(err as Error).message}`);
        }
      })
    );

    log('');
    log(thin);
    log(`  📊 Shards present : ${availableCount} / ${TOTAL_SHARDS}`);
    log(`  📊 Shards missing : ${TOTAL_SHARDS - availableCount} / ${TOTAL_SHARDS}`);
    log(`  📊 Minimum needed : ${DATA_SHARDS} (tolerance: lose up to ${PARITY_SHARDS})`);
    log(thin);

    if (availableCount < DATA_SHARDS) {
      log(`  🚨 UNRECOVERABLE — only ${availableCount} shards available, need at least ${DATA_SHARDS}`);
      log(divider);
      log('');
      const err = new Error(`Cannot reconstruct object ${id}: only ${availableCount} shards available, need at least ${DATA_SHARDS}`);
      (err as any).statusCode = 500;
      throw err;
    }

    if (availableCount < TOTAL_SHARDS) {
      const missing = TOTAL_SHARDS - availableCount;
      log(`  ⚙️  ${missing} shard(s) missing — running Reed-Solomon reconstruction...`);
      const result = rs.reconstruct(shardsBuf, DATA_SHARDS, PARITY_SHARDS, shardsAvailable);
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

    log(thin);
    log(`  ✂️  Removing ${metadata.paddingSize} padding bytes  →  original ${metadata.size} bytes`);
    log(`  📤 Returning file: ${metadata.fileName}`);
    log(divider);
    log('');

    const fileData = shardsBuf.subarray(0, metadata.size);
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
    const shardLocs = ensureShardId(metadata.shards, metadata.id);
    await Promise.all(
      shardLocs.map(async (loc) => {
        try {
          await storageService.deleteShard(loc);
          log(`     🗑  shard ${loc.index}  removed from  ${loc.nodeName}/`);
        } catch (err) {
          log(`     ⚠️  shard ${loc.index}  on ${loc.nodeName}/  delete failed: ${(err as Error).message}`);
        }
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
