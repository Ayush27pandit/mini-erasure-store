export class NodeClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public nodeUrl?: string,
  ) {
    super(message);
    this.name = 'NodeClientError';
  }
}

export class NodeClient {
  constructor(private baseUrl: string) {}

  async saveShard(
    id: string,
    index: number,
    buffer: Uint8Array,
  ): Promise<{ path: string; hash: string }> {
    const res = await fetch(`${this.baseUrl}/shard/${id}/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(buffer),
    });
    if (!res.ok) {
      throw new NodeClientError(
        `Failed to save shard ${index}: ${res.statusText}`,
        res.status,
        this.baseUrl,
      );
    }
    return res.json() as Promise<{ path: string; hash: string }>;
  }

  async readShard(
    id: string,
    index: number,
  ): Promise<{ data: Buffer; hash: string } | null> {
    const res = await fetch(`${this.baseUrl}/shard/${id}/${index}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new NodeClientError(
        `Failed to read shard ${index}: ${res.statusText}`,
        res.status,
        this.baseUrl,
      );
    }
    const data = Buffer.from(await res.arrayBuffer());
    const hash = res.headers.get('X-Shard-Hash') || '';
    return { data, hash };
  }

  async deleteShard(id: string, index: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/shard/${id}/${index}`, {
      method: 'DELETE',
    });
    if (res.status !== 204 && res.status !== 404) {
      throw new NodeClientError(
        `Failed to delete shard ${index}: ${res.statusText}`,
        res.status,
        this.baseUrl,
      );
    }
  }

  async shardExists(id: string, index: number): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/shard/${id}/${index}`, {
      method: 'HEAD',
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new NodeClientError(
        `Failed to check shard ${index}: ${res.statusText}`,
        res.status,
        this.baseUrl,
      );
    }
    return true;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
