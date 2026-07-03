import path from 'path';


export const PORT = process.env.PORT || 3000;

export const STORAGE_DIR = path.resolve(process.cwd(), 'storage');
export const METADATA_FILE = path.resolve(process.cwd(), 'metadata/metadata.json');

// Erasure Coding Parameters
export const DATA_SHARDS = 4;
export const PARITY_SHARDS = 2;
export const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;

// Simulated storage node directories under storage/
export const NODE_NAMES = Array.from({ length: TOTAL_SHARDS }, (_, i) => `node_${i + 1}`);

// Storage node network config — each node runs on a separate port
export const STORAGE_NODE_BASE_PORT = 3001;

// Background repair daemon interval (ms)
export const REPAIR_INTERVAL_MS = 30_000;

