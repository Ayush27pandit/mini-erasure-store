import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { STORAGE_DIR } from '../config/constants.js';

const app = express();
const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const nodeArg = args.find(a => a.startsWith('--node='));
const port = portArg ? parseInt(portArg.split('=')[1]!, 10) : 3001;
const nodeName = nodeArg ? nodeArg.split('=')[1]! : 'node_1';

const nodeDir = path.join(STORAGE_DIR, nodeName);

app.use(express.raw({ type: 'application/octet-stream', limit: '1gb' }));

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

app.put('/shard/:id/:index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, index } = req.params;
    await ensureDir(nodeDir);
    const filePath = path.join(nodeDir, `${id}_shard_${index}.bin`);
    await fs.writeFile(filePath, req.body as Buffer);
    const hash = createHash('sha256').update(req.body as Buffer).digest('hex');
    console.log(`  [${nodeName}] PUT shard ${id}:${index}  (${(req.body as Buffer).length} bytes)  hash=${hash.slice(0, 8)}...`);
    res.json({ path: filePath, hash });
  } catch (err) {
    next(err);
  }
});

app.get('/shard/:id/:index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, index } = req.params;
    const filePath = path.join(nodeDir, `${id}_shard_${index}.bin`);
    const data = await fs.readFile(filePath);
    const hash = createHash('sha256').update(data).digest('hex');
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Shard-Hash', hash);
    res.end(data);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Shard not found' });
      return;
    }
    next(err);
  }
});

app.head('/shard/:id/:index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, index } = req.params;
    const filePath = path.join(nodeDir, `${id}_shard_${index}.bin`);
    await fs.access(filePath);
    res.status(200).end();
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).end();
      return;
    }
    next(err);
  }
});

app.delete('/shard/:id/:index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, index } = req.params;
    const filePath = path.join(nodeDir, `${id}_shard_${index}.bin`);
    await fs.unlink(filePath).catch((err: any) => {
      if (err.code !== 'ENOENT') throw err;
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ node: nodeName, port, status: 'ok' });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${nodeName}] Error:`, err);
  res.status(500).json({ error: err.message || 'Internal storage node error' });
});

app.listen(port, () => {
  console.log(`[storage-node] ${nodeName} started on http://localhost:${port}, storing in ${nodeDir}`);
});
