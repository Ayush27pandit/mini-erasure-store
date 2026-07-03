# mini-erasure-store

A learning-focused mini object store that uses **Reed-Solomon erasure coding** to split files into shards and tolerate node failures.

Upload a file → it's split into **4 data shards + 2 parity shards** → stored across **6 simulated storage nodes**. Download it back even if up to 2 nodes are lost — the parity shards reconstruct what's missing.

---

## What is Erasure Coding?

Erasure coding is a data protection method that spreads data across multiple shards with **redundancy**, but far more efficiently than simple replication.

### Replication vs Erasure Coding

| Approach | 6 nodes | Overhead | Tolerance |
|---|---|---|---|
| 3x replication | 2 data copies across 6 nodes | **200%** | Lose up to 1 copy |
| RS(4,2) erasure coding | 4 data + 2 parity across 6 nodes | **50%** | Lose up to 2 nodes |

**RS(4,2)** means:
- The file is split into **4 data shards**
- **2 parity shards** are computed via Reed-Solomon matrix multiplication
- Any **4 of the 6 shards** can reconstruct the original file
- You lose **2 full nodes** before data becomes unrecoverable

---

## Architecture

```
┌──────────┐     ┌───────────────────────────────────────────────────────────────┐
│  Client  │     │                    Main Server (:3000)                        │
│  curl    │────▶│                                                               │
└──────────┘     │  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
                 │  │  Routes  │─▶│  Controller  │─▶│    ObjectService       │  │
                 │  │ (object  │  │ (object      │  │  upload / download     │  │
                 │  │  .route) │  │  .controller)│  │  delete / list         │  │
                 │  └──────────┘  └──────────────┘  └───────────┬────────────┘  │
                 │                                               │               │
                 │                          ┌────────────────────┼──────────┐    │
                 │                          │  Background Tasks  │          │    │
                 │                          │  ┌─────────────────▼────┐     │    │
                 │                          │  │   RepairService     │     │    │
                 │                          │  │  (checks every 30s) │     │    │
                 │                          │  └────────────────────┘     │    │
                 │                          └─────────────────────────────┘    │
                 │                                                           │
                 │  ┌─────────────────────────────────────────────────────┐   │
                 │  │  Reed-Solomon WASM (encode / reconstruct)          │   │
                 │  └─────────────────────────────────────────────────────┘   │
                 │                                                           │
                 │  ┌─────────────────────────────────────────────────────┐   │
                 │  │  NodeRegistry + NodeClient (HTTP clients × 6)      │   │
                 │  └──────────────────────┬──────────────────────────────┘   │
                 └─────────────────────────┼──────────────────────────────────┘
                                           │
        ┌──────────────────────────────────┼────────────────────────────────────┐
        │            Network              │                                     │
        │    ┌──────┐  ┌──────┐  ┌──────┐ │  ┌──────┐  ┌──────┐  ┌──────┐     │
        │    │:3001 │  │:3002 │  │:3003 │ │  │:3004 │  │:3005 │  │:3006 │     │
        │    │node_1│  │node_2│  │node_3│ │  │node_4│  │node_5│  │node_6│     │
        │    │(data)│  │(data)│  │(data)│ │  │(data)│  │parity│  │parity│     │
        │    └──┬───┘  └──┬───┘  └──┬───┘ │  └──┬───┘  └──┬───┘  └──┬───┘     │
        │       └─────────┴─────────┴──────┼────┴─────────┴─────────┘         │
        │                                  │                                   │
        │  ┌───────────────────────────────┼───────────────────────────────┐   │
        │  │  metadata/metadata.json       │  (SHA-256 hashes per shard)   │   │
        │  │  + background repair daemon   │                               │   │
        │  └───────────────────────────────┘                                   │
        └──────────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Upload Flow

1. **Receive file** — Multer parses the multipart upload into a `Buffer`
2. **Pad** — If the file isn't evenly divisible by `DATA_SHARDS` (4), append zero bytes
3. **Encode** — Copy the padded data into a contiguous buffer, call `rs.encode()` to compute 2 parity shards
4. **Distribute** — For each of the 6 shards, send an HTTP `PUT /shard/:id/:index` to the corresponding storage node (ports 3001–3006). Each node responds with the file path and SHA-256 hash of the shard.
5. **Record metadata** — Save `{ id, fileName, mimeType, size, paddingSize, shardLocations }` to `metadata.json`, including each shard's hash for later integrity verification.

> **Shard size math:** `shardSize = (fileSize + paddingSize) / 4`

### Download Flow

1. **Lookup metadata** — Find the object by ID in `metadata.json`
2. **Fetch shards** — Send 6 concurrent HTTP `GET /shard/:id/:index` requests to the respective storage nodes. Each response includes an `X-Shard-Hash` header.
3. **Verify integrity** — Compute SHA-256 of each received shard and compare against the hash stored in metadata. Mismatches are treated as corrupt (shard unavailable).
4. **Decision:**
   - **All 6 present and valid** → straight concatenation, no reconstruction needed
   - **4 or 5 present** → copy available shards into a buffer, call `rs.reconstruct()` using the missing-indices mask to recover lost shards
   - **3 or fewer present** → raise **unrecoverable** error (not enough redundancy)
5. **Trim padding** — Slice the buffer back to the original file size
6. **Return** — Stream the buffer with original `Content-Type` and `Content-Disposition`

### Delete Flow

1. Send 6 concurrent HTTP `DELETE /shard/:id/:index` requests to the respective storage nodes
2. Remove metadata entry from `metadata.json`

### Background Repair

A repair daemon runs on a 30-second interval:
1. Scans all objects in metadata
2. For each object, probes all 6 storage nodes via `HEAD /shard/:id/:index`
3. If shards are missing but reconstruction is still possible (`>= DATA_SHARDS` available):
   - Reads available shards (with integrity verification)
   - Runs Reed-Solomon reconstruction to recover missing shards
   - Pushes reconstructed shards via `PUT /shard/:id/:index`
   - Updates metadata with new SHA-256 hashes for repaired shards

---

## Failure Tolerance

| Shards Lost | Scenario | Outcome |
|---|---|---|
| 0 | All nodes healthy | Direct download |
| 1 | One node offline | Reconstruction (fast) |
| 2 | Two nodes offline | Reconstruction (still within tolerance) |
| 3+ | Three or more nodes offline | **Unrecoverable** — need at least 4 shards |

---

## Quick Start

```bash
# Install dependencies
npm install

# Terminal 1: Start all 6 storage nodes (ports 3001–3006)
npm run start:nodes

# Terminal 2: Start the main server (port 3000)
npm run dev

# Or use the shortcut that starts everything at once:
npm run start:all
```

Main server on `http://localhost:3000`, storage nodes on ports 3001–3006.

### Running storage nodes individually

```bash
# Each node is a standalone Express server
npm run storage-node -- --port=3001 --node=node_1
npm run storage-node -- --port=3002 --node=node_2
# ... etc
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/upload` | Upload a file (multipart/form-data, field: `file`) |
| `GET` | `/objects/:id` | Download/reconstruct an object by ID |
| `GET` | `/objects` | List all stored objects |
| `DELETE` | `/objects/:id` | Delete an object and all its shards |

### Upload Example

```bash
curl -X POST http://localhost:3000/upload -F "file=@myfile.txt"
# → {"id":"abc-123-..."}
```

### Download Example

```bash
curl -o myfile.txt http://localhost:3000/objects/abc-123-...
```

### List Objects

```bash
curl http://localhost:3000/objects
```

### Delete Object

```bash
curl -X DELETE http://localhost:3000/objects/abc-123-...
# → 204 No Content
```

---

## Manual Testing Walkthrough

```bash
# 0. Prerequisites — start everything (or use separate terminals):
npm run start:all

# 1. Create a test file
echo "Hello, Erasure Coding!" > test.txt

# 2. Upload it
curl -X POST http://localhost:3000/upload -F "file=@test.txt"
# → {"id":"<OBJECT_ID>"}

# 3. Download it (all 6 shards present — no reconstruction)
curl -o downloaded.txt http://localhost:3000/objects/<OBJECT_ID>
diff test.txt downloaded.txt  # should match

# 4. Simulate node failure — kill 2 storage nodes (within tolerance)
kill $(lsof -t -i :3001) $(lsof -t -i :3002)

# 5. Download again — main server logs show:
#    ❌ shard 0 MISSING — node offline
#    ❌ shard 1 MISSING — node offline
#    ⚙️ Running Reed-Solomon reconstruction...
curl -o reconstructed.txt http://localhost:3000/objects/<OBJECT_ID>
diff test.txt reconstructed.txt  # should still match

# 6. Simulate unrecoverable failure — kill 3 more nodes (5 total lost)
kill $(lsof -t -i :3003) $(lsof -t -i :3004) $(lsof -t -i :3005)
curl http://localhost:3000/objects/<OBJECT_ID>  # → 500 error (unrecoverable)

# 7. Restart nodes, watch repair daemon fix them
npm run start:nodes
# After ~30s, the repair daemon detects missing shards,
# reconstructs them, and re-writes to the revived nodes.

# 8. Download again — all 6 shards restored
curl -o repaired.txt http://localhost:3000/objects/<OBJECT_ID>
diff test.txt repaired.txt  # should match

# 9. Delete the object
curl -X DELETE http://localhost:3000/objects/<OBJECT_ID>  # → 204
```

---

## Project Structure

```
mini-erasure-store/
├── src/
│   ├── server.ts                    # Entry point — starts Express + repair daemon
│   ├── app.ts                       # Express app setup + global error handler
│   ├── config/
│   │   └── constants.ts             # Shard counts, ports, repair interval
│   ├── models/
│   │   └── object.model.ts          # TypeScript types (ObjectMetaData, ShardLocation)
│   ├── routes/
│   │   └── object.route.ts          # Route definitions + multer config
│   ├── controller/
│   │   └── object.controller.ts     # HTTP layer — parse request, format response
│   ├── services/
│   │   ├── object.service.ts         # Core logic — upload, download/reconstruct, delete
│   │   └── hash.service.ts          # SHA-256 computation + verification
│   ├── infrastructure/
│   │   ├── node-registry.ts         # Maps node names to HTTP URLs
│   │   └── node-client.ts           # HTTP client for storage node CRUD
│   ├── storage/
│   │   └── storage.service.ts       # Shard I/O via NodeClient + integrity checks
│   ├── storage-node/
│   │   └── index.ts                 # Standalone storage node server (PUT/GET/DELETE/HEAD)
│   ├── repair/
│   │   └── repair.service.ts        # Background daemon — detects + fixes missing shards
│   └── metadata/
│       └── metadata.service.ts      # CRUD for metadata.json (atomic writes)
├── storage/
│   ├── node_1/                      # Data shard 0
│   ├── node_2/                      # Data shard 1
│   ├── node_3/                      # Data shard 2
│   ├── node_4/                      # Data shard 3
│   ├── node_5/                      # Parity shard 4
│   └── node_6/                      # Parity shard 5
├── metadata/
│   └── metadata.json                # Object → shard-location mappings with SHA-256 hashes
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration

All constants in `src/config/constants.ts`:

| Variable | Default | Description |
|---|---|---|
| Variable | Default | Description |
|---|---|---|---|
| `PORT` | `3000` | Main server HTTP port |
| `DATA_SHARDS` | `4` | Number of data shards the file is split into |
| `PARITY_SHARDS` | `2` | Number of parity (recovery) shards |
| `TOTAL_SHARDS` | `6` | `DATA_SHARDS + PARITY_SHARDS` |
| `STORAGE_DIR` | `./storage` | Root directory for storage node data |
| `METADATA_FILE` | `./metadata/metadata.json` | Metadata persistence file |
| `STORAGE_NODE_BASE_PORT` | `3001` | Port of the first storage node (node_1). Each subsequent node gets +1. |
| `REPAIR_INTERVAL_MS` | `30000` | Background repair daemon scan interval (milliseconds) |

To change the redundancy level, adjust `DATA_SHARDS` and `PARITY_SHARDS`. For example, RS(6,3) would tolerate 3 node failures with 50% overhead (6 data + 3 parity = 9 total).

---

## Next Steps / Learning Path

### Level 2 — Distribution & Discovery

- **Node registry with dynamic discovery** — Currently the registry is a static config. Build a real registry with service discovery (etcd, Consul, or a simple Raft-backed store) so nodes can join/leave without restarting the main server.
- **Client-side load balancing** — When reading shards, prefer faster or geographically closer nodes.

### Level 3 — Production Patterns

- **Real database for metadata** — Replace `metadata.json` with SQLite or PostgreSQL for atomic concurrent access, backups, and querying.
- **Streaming encode/decode** — Process files in chunks instead of loading the whole buffer into memory. Enables multi-GB file support.
- **Consistent hashing** — Map shards to nodes via a hash ring so adding/removing nodes minimizes data reshuffling (like Amazon Dynamo).

### Level 4 — Advanced Concepts

- **Multi-DC replication** — Namespace objects by tenant, create RS groups per region, implement cross-region replication.
- **Tiered storage** — Hot objects: 3x replication. Cold objects: erasure coded. Policy-driven tiering based on access frequency (like Facebook's f4).
- **Property-based tests** — Randomized tests that drop any 2 of 6 shards and verify the output matches the input byte-for-byte.

---

Built with:
  - [TypeScript](https://www.typescriptlang.org/) + [Express 5](https://expressjs.com/)
  - [Multer](https://github.com/expressjs/multer) (file upload parsing)
  - [@digitaldefiance/reed-solomon-erasure.wasm](https://github.com/digitaldefiance/reed-solomon-erasure) (WASM Reed-Solomon encoding)
  - [uuid](https://github.com/uuidjs/uuid) (object ID generation)
