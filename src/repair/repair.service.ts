import { readFileSync } from 'fs';
import path from 'path';
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm';
import { metadataService } from '../metadata/metadata.service.js';
import { storageService } from '../storage/storage.service.js';
import { DATA_SHARDS, PARITY_SHARDS, TOTAL_SHARDS, REPAIR_INTERVAL_MS } from '../config/constants.js';
import type { ObjectMetaData, ShardLocation } from '../models/object.model.js';

const wasmPath = path.resolve(process.cwd(), 'node_modules/@digitaldefiance/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const rs = ReedSolomonErasure.fromBytes(wasmBytes);

function log(msg: string) { console.log(`[repair] ${msg}`); }

export class RepairService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    log(`Started — checking every ${REPAIR_INTERVAL_MS / 1000}s`);
    this.tick();
    this.timer = setInterval(() => this.tick(), REPAIR_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    log('Stopped');
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const objects = await metadataService.listObjects();
      if (objects.length === 0) return;

      const healthyNodes = await storageService.healthyNodeCount();
      log(`Scanning ${objects.length} object(s)  |  healthy nodes: ${healthyNodes}/${TOTAL_SHARDS}`);

      for (const obj of objects) {
        await this.repairObject(obj);
      }
    } catch (err) {
      log(`Error during repair cycle: ${(err as Error).message}`);
    }
  }

  private async repairObject(metadata: ObjectMetaData): Promise<void> {
    const shardLocs = metadata.shards.map(s => ({
      ...s,
      objectId: s.objectId || metadata.id,
    }));

    const available: ShardLocation[] = [];
    const missing: ShardLocation[] = [];

    for (const loc of shardLocs) {
      const exists = await storageService.shardExists(loc);
      if (exists) {
        available.push(loc);
      } else {
        missing.push(loc);
      }
    }

    if (missing.length === 0) return;

    log(`  ${metadata.fileName} (${metadata.id.slice(0, 8)}...)  —  ${available.length}/${TOTAL_SHARDS} shards, ${missing.length} missing`);

    if (available.length < DATA_SHARDS) {
      log(`    🚨 Unrecoverable — only ${available.length} shards available, need ${DATA_SHARDS}`);
      return;
    }

    log(`    ⚙️  Reconstructing ${missing.length} missing shard(s)...`);

    const totalPaddedLength = metadata.size + metadata.paddingSize;
    const shardSize = totalPaddedLength / DATA_SHARDS;

    const buffer = new Uint8Array(shardSize * TOTAL_SHARDS);
    const shardsPresent = new Array<boolean>(TOTAL_SHARDS).fill(false);

    for (const loc of available) {
      const data = await storageService.readShard(loc);
      if (data) {
        buffer.set(data, loc.index * shardSize);
        shardsPresent[loc.index] = true;
      }
    }

    const result = rs.reconstruct(buffer, DATA_SHARDS, PARITY_SHARDS, shardsPresent);
    if (result !== ReedSolomonErasure.RESULT_OK) {
      log(`    🚨 Reconstruction failed with code ${result}`);
      return;
    }

    log(`    ✅ Reconstruction successful, re-writing ${missing.length} shard(s)...`);

    for (const loc of missing) {
      const shardData = buffer.subarray(loc.index * shardSize, (loc.index + 1) * shardSize);
      try {
        const { hash } = await storageService.saveShard(loc.nodeName, metadata.id, loc.index, shardData);
        const type = loc.index < DATA_SHARDS ? 'DATA  ' : 'PARITY';
        loc.hash = hash;
        log(`      🔄 [${type}] shard ${loc.index}  →  ${loc.nodeName}/  (${shardData.length} bytes)  hash=${hash.slice(0, 8)}...`);
      } catch (err) {
        log(`      ❌ Failed to write shard ${loc.index} to ${loc.nodeName}: ${(err as Error).message}`);
      }
    }

    await metadataService.saveMetadata(metadata);
    log(`    📄 Metadata updated for ${metadata.id.slice(0, 8)}...`);
  }
}

export const repairService = new RepairService();
