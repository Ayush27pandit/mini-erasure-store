import fs from 'fs/promises';
import path from 'path';
import { STORAGE_DIR, NODE_NAMES } from '../config/constants.js';

export class StorageService {
  private initialized = false;

  private async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(STORAGE_DIR, { recursive: true });
      for (const nodeName of NODE_NAMES) {
        await fs.mkdir(path.join(STORAGE_DIR, nodeName), { recursive: true });
      }
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing storage nodes:', error);
      throw error;
    }
  }

  // Save a single shard to a specific storage node folder
  async saveShard(nodeName: string, id: string, shardIndex: number, buffer: Uint8Array): Promise<string> {
    await this.init();
    const filePath = path.join(STORAGE_DIR, nodeName, `${id}_shard_${shardIndex}.bin`);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (error) {
      console.error(`Error writing shard ${shardIndex} to node ${nodeName}:`, error);
      throw error;
    }
    return filePath;
  }

  // Read a single shard from disk
  async readShard(storagePath: string): Promise<Buffer> {
    return await fs.readFile(storagePath);
  }

  // Delete a single shard from disk
  async deleteShard(storagePath: string): Promise<void> {
    await fs.unlink(storagePath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  // Check if a single shard exists
  async shardExists(storagePath: string): Promise<boolean> {
    try {
      await fs.access(storagePath);
      return true;
    } catch {
      return false;
    }
  }
}

export const storageService = new StorageService();
