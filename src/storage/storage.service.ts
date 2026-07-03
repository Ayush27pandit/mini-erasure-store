import { nodeRegistry } from '../infrastructure/node-registry.js';
import { NodeClient } from '../infrastructure/node-client.js';
import { hashService } from '../services/hash.service.js';
import type { ShardLocation } from '../models/object.model.js';

export class ShardNotFoundError extends Error {
  constructor(shardIndex: number, nodeName: string) {
    super(`Shard ${shardIndex} not found on ${nodeName}`);
    this.name = 'ShardNotFoundError';
  }
}

export class StorageService {
  private clients = new Map<string, NodeClient>();

  getClient(nodeName: string): NodeClient {
    let client = this.clients.get(nodeName);
    if (!client) {
      const url = nodeRegistry.getUrl(nodeName);
      client = new NodeClient(url);
      this.clients.set(nodeName, client);
    }
    return client;
  }

  async saveShard(
    nodeName: string,
    id: string,
    shardIndex: number,
    buffer: Uint8Array,
  ): Promise<{ path: string; hash: string }> {
    const client = this.getClient(nodeName);
    const result = await client.saveShard(id, shardIndex, buffer);
    return { path: result.path, hash: result.hash };
  }

  async readShard(loc: ShardLocation): Promise<Buffer | null> {
    const client = this.getClient(loc.nodeName);
    const result = await client.readShard(loc.objectId, loc.index);
    if (!result) return null;

    if (!hashService.verify(result.data, loc.hash)) {
      console.error(`  🚨 INTEGRITY FAILURE: shard ${loc.index} on ${loc.nodeName} — hash mismatch`);
      console.error(`     Expected: ${loc.hash}`);
      console.error(`     Actual:   ${hashService.compute(result.data)}`);
      return null;
    }

    return result.data;
  }

  async deleteShard(loc: ShardLocation): Promise<void> {
    const client = this.getClient(loc.nodeName);
    await client.deleteShard(loc.objectId, loc.index);
  }

  async shardExists(loc: ShardLocation): Promise<boolean> {
    const client = this.getClient(loc.nodeName);
    return client.shardExists(loc.objectId, loc.index);
  }

  async allNodesHealthy(): Promise<boolean> {
    const results = await Promise.all(
      nodeRegistry.getAll().map(n => this.getClient(n.name).health()),
    );
    return results.every(Boolean);
  }

  async healthyNodeCount(): Promise<number> {
    const results = await Promise.all(
      nodeRegistry.getAll().map(n => this.getClient(n.name).health()),
    );
    return results.filter(Boolean).length;
  }
}

export const storageService = new StorageService();
