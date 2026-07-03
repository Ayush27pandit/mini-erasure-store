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
┌──────────┐     ┌─────────────────────────────────────────────────────┐
│  Client  │     │                  Express Server                     │
│  curl    │────▶│                                                     │
└──────────┘     │  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
                 │  │  Routes  │─▶│  Controller  │─▶│    Service    │ │
                 │  │ (object  │  │ (object      │  │ (object       │ │
                 │  │  .route) │  │  .controller)│  │  .service)    │ │
                 │  └──────────┘  └──────────────┘  └───────┬───────┘ │
                 │                                          │         │
                 │                                  ┌───────▼───────┐ │
                 │                                  │ Reed-Solomon  │ │
                 │                                  │  WASM Binary  │ │
                 │                                  │  (encode/     │ │
                 │                                  │  reconstruct) │ │
                 │                                  └───────┬───────┘ │
                 └──────────────────────────────────────────┼─────────┘
                                                            │
        ┌───────────────────────────────────────────────────┼─────────────────────┐
        │                       Disk Storage                │                     │
        │                                                   ▼                     │
        │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐ │
        │  │ node_1 │  │ node_2 │  │ node_3 │  │ node_4 │  │ node_5 │  │ node_6 │ │
        │  │ shard_0│  │ shard_1│  │ shard_2│  │ shard_3│  │ shard_4│  │ shard_5│ │
        │  │ (data) │  │ (data) │  │ (data) │  │ (data) │  │(parity)│  │(parity)│ │
        │  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘ │
        │                                                                         │
        │  ┌───────────────────────────────────────────────────────────────────┐   │
        │  │  metadata/metadata.json  (maps object IDs → shard locations)     │   │
        │  └───────────────────────────────────────────────────────────────────┘   │
        └─────────────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Upload Flow

1. **Receive file** — Multer parses the multipart upload into a `Buffer`
2. **Pad** — If the file isn't evenly divisible by `DATA_SHARDS` (4), append zero bytes
3. **Encode** — Copy the padded data into a contiguous buffer, then call `rs.encode()` to compute 2 parity shards
4. **Distribute** — Write each of the 6 shards to `storage/node_X/<uuid>_shard_Y.bin`
5. **Record metadata** — Save `{ id, fileName, mimeType, size, paddingSize, shardLocations }` to `metadata.json`

> **Shard size math:** `shardSize = (fileSize + paddingSize) / 4`

### Download Flow

1. **Lookup metadata** — Find the object by ID in `metadata.json`
2. **Check shards** — Probe all 6 storage paths; record which are present and which are missing
3. **Decision:**
   - **All 6 present** → straight concatenation, no reconstruction needed
   - **4 or 5 present** → copy available shards into a buffer, call `rs.reconstruct()` using the missing-indices mask to recover lost shards
   - **3 or fewer present** → raise **unrecoverable** error (not enough redundancy)
4. **Trim padding** — Slice the buffer back to the original file size
5. **Return** — Stream the buffer with original `Content-Type` and `Content-Disposition`

### Delete Flow

1. Delete all 6 shard files from their respective node directories
2. Remove metadata entry from `metadata.json`

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

# Start the server
npm run dev
```

Server starts on `http://localhost:3000`.

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
# 1. Create a test file
echo "Hello, Erasure Coding!" > test.txt

# 2. Upload it
curl -X POST http://localhost:3000/upload -F "file=@test.txt"
# → {"id":"<OBJECT_ID>"}

# 3. Download it (all 6 shards present — no reconstruction)
curl -o downloaded.txt http://localhost:3000/objects/<OBJECT_ID>
diff test.txt downloaded.txt  # should match

# 4. Simulate node failure — delete 2 shards (within tolerance)
rm storage/node_1/<OBJECT_ID>_shard_0.bin
rm storage/node_2/<OBJECT_ID>_shard_1.bin

# 5. Download again — logs show Reed-Solomon reconstructing lost shards
curl -o reconstructed.txt http://localhost:3000/objects/<OBJECT_ID>
diff test.txt reconstructed.txt  # should still match

# 6. Simulate unrecoverable failure — delete 3+ shards
rm storage/node_3/<OBJECT_ID>_shard_*.bin
rm storage/node_4/<OBJECT_ID>_shard_*.bin
curl http://localhost:3000/objects/<OBJECT_ID>  # → 500 error (unrecoverable)

# 7. Upload fresh, then delete
curl -X DELETE http://localhost:3000/objects/<OTHER_ID>  # → 204
```

---

## Project Structure

```
mini-erasure-store/
├── src/
│   ├── server.ts                 # Entry point — starts Express on PORT
│   ├── app.ts                    # Express app setup + global error handler
│   ├── config/
│   │   └── constants.ts          # Shard counts, paths, node names
│   ├── models/
│   │   └── object.model.ts       # TypeScript types (ObjectMetaData, ShardLocation)
│   ├── routes/
│   │   └── object.route.ts       # Route definitions + multer config
│   ├── controller/
│   │   └── object.controller.ts  # HTTP layer — parse request, format response
│   ├── services/
│   │   └── object.service.ts     # Core logic — upload, download/reconstruct, delete
│   ├── metadata/
│   │   └── metadata.service.ts   # CRUD for metadata.json (atomic writes)
│   └── storage/
│       └── storage.service.ts    # Read/write/delete shard files on disk
├── storage/
│   ├── node_1/                   # Data shard 0
│   ├── node_2/                   # Data shard 1
│   ├── node_3/                   # Data shard 2
│   ├── node_4/                   # Data shard 3
│   ├── node_5/                   # Parity shard 4
│   └── node_6/                   # Parity shard 5
├── metadata/
│   └── metadata.json             # Object → shard-location mappings
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration

All constants in `src/config/constants.ts`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `DATA_SHARDS` | `4` | Number of data shards the file is split into |
| `PARITY_SHARDS` | `2` | Number of parity (recovery) shards |
| `TOTAL_SHARDS` | `6` | `DATA_SHARDS + PARITY_SHARDS` |
| `STORAGE_DIR` | `./storage` | Root directory for simulated storage nodes |
| `METADATA_FILE` | `./metadata/metadata.json` | Metadata persistence file |

To change the redundancy level, adjust `DATA_SHARDS` and `PARITY_SHARDS`. For example, RS(6,3) would tolerate 3 node failures with 50% overhead (6 data + 3 parity = 9 total).

---

## Next Steps / Learning Path

### Level 1 — Hardening & Realism

- **Integrity checks** — Store SHA-256 hashes per shard in metadata. Verify on download to catch silent corruption.
- **Background repair daemon** — Periodically scan shards. When fewer than `TOTAL_SHARDS` but at least `DATA_SHARDS` are found, reconstruct missing shards and re-write them.
- **Real node simulation** — Run each "node" as a separate HTTP process. Losing a node means connection refused, not just a missing file. Forces proper retry/timeout logic.

### Level 2 — Distribution & Discovery

- **Network storage nodes** — Each node exposes `GET/PUT/DELETE /shard/:id` over HTTP. The upload/download service fans out requests across multiple hosts.
- **Node registry + heartbeats** — Track liveness. Skip dead nodes during reads; trigger repair for them.

### Level 3 — Production Patterns

- **Real database** — Replace `metadata.json` with SQLite or PostgreSQL for atomic concurrent access.
- **Streaming encode/decode** — Process files in chunks instead of loading the whole buffer, enabling multi-GB file support.
- **Consistent hashing** — Map shards to nodes via a hash ring so adding/removing nodes minimizes reshuffling.

### Level 4 — Advanced Concepts

- **Multi-DC replication** — Namespace by tenant, RS groups per region, cross-region replication.
- **Tiered storage** — Hot objects replicated 3x, cold objects erasure-coded (like Facebook's f4).
- **Property-based tests** — Randomized tests that drop any 2 of 6 shards and verify the output matches the input byte-for-byte.

---

Built with:
  - [TypeScript](https://www.typescriptlang.org/) + [Express 5](https://expressjs.com/)
  - [Multer](https://github.com/expressjs/multer) (file upload parsing)
  - [@digitaldefiance/reed-solomon-erasure.wasm](https://github.com/digitaldefiance/reed-solomon-erasure) (WASM Reed-Solomon encoding)
  - [uuid](https://github.com/uuidjs/uuid) (object ID generation)
