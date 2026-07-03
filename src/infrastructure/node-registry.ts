import { STORAGE_NODE_BASE_PORT, NODE_NAMES, TOTAL_SHARDS } from '../config/constants.js';

export interface NodeInfo {
  name: string;
  url: string;
}

export class NodeRegistry {
  private nodes: NodeInfo[];

  constructor() {
    this.nodes = NODE_NAMES.map((name, i) => ({
      name,
      url: `http://localhost:${STORAGE_NODE_BASE_PORT + i}`,
    }));
  }

  getAll(): NodeInfo[] {
    return this.nodes;
  }

  getByIndex(index: number): NodeInfo {
    return this.nodes[index]!;
  }

  getByName(name: string): NodeInfo | undefined {
    return this.nodes.find(n => n.name === name);
  }

  getUrl(nodeName: string): string {
    const node = this.getByName(nodeName);
    if (!node) throw new Error(`Unknown storage node: ${nodeName}`);
    return node.url;
  }
}

export const nodeRegistry = new NodeRegistry();
