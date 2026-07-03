import fs from 'fs/promises';
import path from 'path';
import { METADATA_FILE } from '../config/constants.js';
import type { ObjectMetaData } from '../models/object.model.js';

export class MetadataService {
    //here we read all the metadata from the metadata.json file
  private async readAll(): Promise<Record<string, ObjectMetaData>> {
    try {
      const content = await fs.readFile(METADATA_FILE, 'utf-8');
      if (!content.trim()) return {};
      return JSON.parse(content);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        await fs.mkdir(path.dirname(METADATA_FILE), { recursive: true });
        await fs.writeFile(METADATA_FILE, '{}', 'utf-8');
        return {};
      }
      throw err;
    }
  }

  //here we write all the metadata into the metadata.json file
  private async writeAll(data: Record<string, ObjectMetaData>): Promise<void> {
    await fs.mkdir(path.dirname(METADATA_FILE), { recursive: true });
    // Write atomically by writing to temporary file first, then renaming
    const tempFile = `${METADATA_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempFile, METADATA_FILE);
  }

  //here we save the metadata into the metadata.json file
  async saveMetadata(metadata: ObjectMetaData): Promise<void> {
    const data = await this.readAll();
    data[metadata.id] = metadata;
    await this.writeAll(data);
  }

  async getMetadata(id: string): Promise<ObjectMetaData | null> {
    const data = await this.readAll();
    return data[id] || null;
  }

  async deleteMetadata(id: string): Promise<void> {
    const data = await this.readAll();
    if (data[id]) {
      delete data[id];
      await this.writeAll(data);
    }
  }

  async listObjects(): Promise<ObjectMetaData[]> {
    const data = await this.readAll();
    return Object.values(data);
  }
}

export const metadataService = new MetadataService();
 