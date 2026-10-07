# Repository AI Assistant

A lightweight, reliable repository analysis, code chunking, vector indexing, and semantic search engine inspired by Cursor/Copilot-style systems. It indexes source code using WebAssembly-based Tree-sitter grammars, produces semantic code chunks, generates high-dimensional embeddings, and provides persistent vector search using cosine similarity.

---

## Architecture Pipeline

```text
Phase 1:
Repository → AST → Symbols
       │
       ▼
Phase 2A:
Symbols → Code Chunks
       │
       ▼
Phase 2B:
Code Chunks → Embeddings
       │
       ▼
Phase 2C:
Vector Storage + Semantic Search
```

```
Repository Root
       │
       ▼
src/utils/walkRepo.ts  ──► Recursive directory discovery (.js, .jsx, .ts, .tsx)
       │
       ▼
src/repoMap.ts         ──► Tree-sitter AST parsing & symbol extraction
       │
       ▼
src/codeChunks.ts      ──► Semantic code chunking with line preservation
       │
       ▼
src/embeddings.ts      ──► OpenAI embedding generation (text-embedding-3-small)
       │
       ▼
src/vectorStore.ts     ──► Local JSON Vector Store (.data/vector-store.json)
       │                   ├── Persistence (saveToFile / loadFromFile)
       │                   ├── Cosine Similarity: dot(A, B) / (||A|| * ||B||)
       │                   └── Top-K Semantic Search
```

---

## Phase 2C: Vector Storage & Semantic Search

### What is a Vector Store?
A **vector store** is a database designed to store vector records (arrays of floating-point numbers) alongside their source metadata. In this phase, we use a clean, local JSON-based index (`.data/vector-store.json`) that can be loaded, queried, and persisted without needing external infrastructure.

### What is Cosine Similarity?
**Cosine similarity** measures the cosine of the angle between two multi-dimensional vectors:

$$\text{similarity}(A, B) = \frac{A \cdot B}{\|A\| \times \|B\|} = \frac{\sum A_i B_i}{\sqrt{\sum A_i^2} \sqrt{\sum B_i^2}}$$

- A score of `1.0` means the vectors point in the identical semantic direction (perfect match).
- A score of `0.0` means the vectors are orthogonal (unrelated concepts).
- A score near `-1.0` means the vectors represent diametrically opposed concepts.

### How Indexing Works (`npm run index`)
1. Analyzes the target codebase and creates semantic code chunks.
2. Batches chunks and calls the embedding API to produce 1,536-dimensional vectors.
3. Associates each chunk with its vector and writes the index to `.data/vector-store.json`.

### How Semantic Search Works (`npm run search`)
1. Loads the stored vectors from `.data/vector-store.json`.
2. Generates an embedding for the user's natural-language query using OpenAI API.
3. Computes the cosine similarity between the query vector and every stored code chunk vector.
4. Ranks the chunks from highest similarity to lowest and returns the Top-K results.

> **Note:** Generative AI responses, RAG prompts, LLM chat, and automated code editing are **not** part of Phase 2C and will be introduced in subsequent phases.

---

## Data Structures

### VectorRecord & SearchResult (Phase 2C)
```ts
export interface VectorRecord {
  id: string;
  chunk: CodeChunk;
  embedding: number[];
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number; // Cosine similarity score [-1.0 to 1.0]
}
```

---

## Scripts & Usage

### 1. View Code Chunks (Phase 2A)
```bash
npm start
```

### 2. View Embedding Pipeline (Phase 2B)
```bash
npm run embed
```

### 3. Build & Persist Vector Index (Phase 2C)
```bash
npm run index
```

### 4. Perform Semantic Search (Phase 2C)
```bash
npm run search -- "Where is authentication handled?"
```

Example Search Output:
```text
==========================================
Semantic Search (Phase 2C)
==========================================

Query: Where is authentication handled?

1. AuthService
   File: sample-repo/auth.js
   Lines: 9-13
   Type: class
   Similarity: 0.8712

   class AuthService {
     login(user) {
       return generateToken(user);
     }
   }

2. generateToken
   File: sample-repo/auth.js
   Lines: 1-3
   Type: function
   Similarity: 0.8245

   function generateToken(user) {
     return jwt.sign({ id: user.id }, SECRET);
   }
```

### 5. Run Automated Tests
Runs all unit and integration tests (zero network calls, zero API key required):
```bash
npm test
```

### 6. Type Check
```bash
npx tsc --noEmit
```