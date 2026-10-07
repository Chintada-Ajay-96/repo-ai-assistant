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
       │
       ▼
Phase 2D:
Retrieval & Context Preparation
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
       │
       ▼
src/retrieval.ts       ──► Retrieval & Context Preparation
                           ├── Query embedding & vector store query
                           ├── Result deduplication via stable chunk IDs
                           ├── Strict character limit budget (maxCharacters)
                           └── Structured LLM context formatting
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

## Phase 2D: Retrieval & RAG Context Preparation

### What is Retrieval?
**Retrieval** is the process of taking a developer's natural-language query and locating the most relevant fragments of source code from across the repository. Rather than handing raw search scores back to the user, retrieval bridges vector search with context construction, returning code chunks ready for processing.

### How Semantic Search Differs from Retrieval
- **Semantic Search (Phase 2C)** is a mathematical ranking primitive. It computes cosine similarity between a query embedding and indexed code embeddings to output a ranked list of scores and chunks.
- **Retrieval & Context Preparation (Phase 2D)** is an orchestration layer built on top of search. It validates queries, generates query embeddings, queries the vector store, removes duplicate chunks using stable chunk IDs, enforces strict token/character budgets, and formats the retrieved chunks into clean, structured prompt context for an eventual LLM.

### Why We Build Context
Large Language Models have finite context windows, incur higher latency and token costs with large inputs, and can become confused by irrelevant noise. We build a structured context so that a downstream LLM receives only the high-signal, relevant code snippets junto with critical metadata (file path, symbol name, symbol type, parent class, line range, similarity score, and code).

### Why the LLM is Not Involved Yet
In professional RAG systems, **retrieval quality determines generation quality** ("garbage in, garbage out"). By isolating Phase 2D, we verify and test that chunk retrieval, ranking, deduplication, and character budgeting work with 100% determinism before introducing non-deterministic LLM API calls or chat interfaces.

### How Top-K Works
The `topK` parameter (default `5`) defines how many top-ranking semantic neighbors to retrieve from the vector index. Chunks are sorted descending by their cosine similarity score, and only the top `K` chunks are considered for the final context.

### How the Character Limit Works
The `maxCharacters` parameter (default `12000`) sets a hard ceiling on the length of the generated context:
1. Chunks are evaluated in strict ranking order (highest similarity first).
2. For each chunk, the builder tests whether adding it to the context will keep the total characters within `maxCharacters`.
3. **Never cut in the middle:** A code chunk is either included completely or excluded entirely.
4. If adding a chunk would exceed `maxCharacters`, the builder stops adding further chunks to preserve ranking integrity.

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

### RetrievedChunk, RetrievalResult, & ContextResult (Phase 2D)
```ts
export interface RetrievedChunk {
  chunk: CodeChunk;
  score: number; // Cosine similarity score [-1.0 to 1.0]
}

export interface RetrievalResult {
  query: string;
  results: RetrievedChunk[];
}

export interface ContextResult {
  context: string;
  includedChunks: number;
  totalCharacters: number;
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

### 5. Retrieve Code & Build LLM Context (Phase 2D)
```bash
npm run retrieve -- "Where is authentication handled?"
```

Example Retrieval Output:
```text
==========================================
Code Retrieval (Phase 2D)
==========================================

Query:
Where is authentication handled?

Retrieved chunks:

1. AuthService
   File: sample-repo/auth.js
   Score: 0.8712

2. generateToken
   File: sample-repo/auth.js
   Score: 0.8245

==========================================
LLM CONTEXT
==========================================

--------------------------------------------------
File: sample-repo/auth.js
Symbol: AuthService
Type: class
Lines: 9-13
Similarity: 0.8712

class AuthService {
  login(user) {
    return generateToken(user);
  }
}
--------------------------------------------------
File: sample-repo/auth.js
Symbol: generateToken
Type: function
Lines: 1-3
Similarity: 0.8245

function generateToken(user) {
  return jwt.sign({ id: user.id }, SECRET);
}
--------------------------------------------------
```

### 6. Run Automated Tests
Runs all unit and integration tests (zero network calls, zero API key required):
```bash
npm test
```

### 7. Type Check
```bash
npx tsc --noEmit
```