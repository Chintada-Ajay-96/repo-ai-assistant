# Repository AI Assistant

A lightweight, reliable repository analysis, code chunking, vector indexing, semantic search, and RAG question answering engine inspired by Cursor/Copilot-style systems. It indexes source code using WebAssembly-based Tree-sitter grammars, produces semantic code chunks, generates high-dimensional embeddings with Google Gemini, and provides persistent vector search and grounded LLM answer generation.

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
Phase 2B-G:
Code Chunks → Gemini Embeddings (gemini-embedding-001)
       │
       ▼
Phase 2C:
Vector Storage + Semantic Search
       │
       ▼
Phase 2D:
Retrieval & Context Preparation
       │
       ▼
Phase 3A:
LLM Answer Generation Client (Gemini)
       │
       ▼
Phase 3B:
Complete Grounded RAG Answer Generation
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
src/embeddings.ts      ──► Gemini embedding generation (gemini-embedding-001)
       │                   ├── Provider-independent EmbeddingClient interface
       │                   ├── Official Google Gen AI SDK (@google/genai)
       │                   ├── Configurable batching & ordering preservation
       │                   └── Query embedding in unified vector space
       │
       ▼
src/vectorStore.ts     ──► Local JSON Vector Store (.data/vector-store.json)
       │                   ├── Persistence (saveToFile / loadFromFile)
       │                   ├── Cosine Similarity: dot(A, B) / (||A|| * ||B||)
       │                   └── Top-K Semantic Search
       │
       ▼
src/retrieval.ts       ──► Retrieval & Context Preparation
       │                   ├── Query embedding & vector store query
       │                   ├── Result deduplication via stable chunk IDs
       │                   ├── Strict character limit budget (maxCharacters)
       │                   └── Structured LLM context formatting
       │
       ▼
src/llm.ts             ──► LLM Answer Generation Client (Phase 3A)
       │                   ├── Provider-independent LLMClient interface
       │                   ├── Official Google Gen AI SDK (@google/genai)
       │                   ├── Default Flash model (gemini-2.5-flash)
       │                   └── Safe response handling & error propagation
       │
       ▼
src/answer.ts          ──► RAG Answer Generation Orchestrator (Phase 3B)
                           ├── Query retrieval & context building
                           ├── Grounded prompt construction
                           ├── Empty retrieval handling (no hallucination)
                           └── End-to-end answer generation via LLMClient
```

---

## Unified Gemini Provider Architecture (Phase 2B-G)

The project uses **Google Gemini** as the single unified provider for all AI capabilities:
1. **Code Embeddings:** Generated using Gemini's official `gemini-embedding-001` model.
2. **Query Embeddings:** Generated using the same Gemini `gemini-embedding-001` model to guarantee identical embedding space alignment.
3. **Text Generation:** Generated using Gemini Flash (`gemini-2.5-flash`).

### API Key Requirement
The application requires only a single environment variable:
```bash
GEMINI_API_KEY="your-gemini-api-key"
```
There is **no** dependency on OpenAI or `OPENAI_API_KEY`.

### Vector Store Migration Note
Because the embedding provider and model changed to Gemini (`gemini-embedding-001`):
- Any previous vector stores generated with other models are considered **stale** and incompatible.
- Running `npm run index` will cleanly overwrite and rebuild `.data/vector-store.json` using Gemini embeddings.

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
2. Batches chunks and calls the Gemini embedding API (`gemini-embedding-001`) to produce embedding vectors.
3. Associates each chunk with its vector and writes the index to `.data/vector-store.json`.

### How Semantic Search Works (`npm run search`)
1. Loads the stored vectors from `.data/vector-store.json`.
2. Generates an embedding for the user's natural-language query using Gemini API.
3. Computes the cosine similarity between the query vector and every stored code chunk vector.
4. Ranks the chunks from highest similarity to lowest and returns the Top-K results.

---

## Phase 2D: Retrieval & RAG Context Preparation

### What is Retrieval?
**Retrieval** is the process of taking a developer's natural-language query and locating the most relevant fragments of source code from across the repository. Rather than handing raw search scores back to the user, retrieval bridges vector search with context construction, returning code chunks ready for processing.

### How Semantic Search Differs from Retrieval
- **Semantic Search (Phase 2C)** is a mathematical ranking primitive. It computes cosine similarity between a query embedding and indexed code embeddings to output a ranked list of scores and chunks.
- **Retrieval & Context Preparation (Phase 2D)** is an orchestration layer built on top of search. It validates queries, generates query embeddings, queries the vector store, removes duplicate chunks using stable chunk IDs, enforces strict token/character budgets, and formats the retrieved chunks into clean, structured prompt context for an eventual LLM.

### Why We Build Context
Large Language Models have finite context windows, incur higher latency and token costs with large inputs, and can become confused by irrelevant noise. We build a structured context so that a downstream LLM receives only the high-signal, relevant code snippets together with critical metadata (file path, symbol name, symbol type, parent class, line range, similarity score, and code).

### How Top-K Works
The `topK` parameter (default `5`) defines how many top-ranking semantic neighbors to retrieve from the vector index. Chunks are sorted descending by their cosine similarity score, and only the top `K` chunks are considered for the final context.

### How the Character Limit Works
The `maxCharacters` parameter (default `12000`) sets a hard ceiling on the length of the generated context:
1. Chunks are evaluated in strict ranking order (highest similarity first).
2. For each chunk, the builder tests whether adding it to the context will keep the total characters within `maxCharacters`.
3. **Never cut in the middle:** A code chunk is either included completely or excluded entirely.
4. If adding a chunk would exceed `maxCharacters`, the builder stops adding further chunks to preserve ranking integrity.

---

## Phase 3A: LLM Answer Generation Client

### Overview
Phase 3A introduces a clean, provider-independent LLM client abstraction ([`src/llm.ts`](src/llm.ts)) for generating natural-language text responses:

- **LLM Provider:** Google Gemini is used as the LLM provider via the official `@google/genai` SDK.
- **Model:** Defaults to `gemini-2.5-flash` (configurable through client options).
- **Environment Configuration:** Requires `GEMINI_API_KEY` to be set in the environment or `.env` file for actual generation.
- **Mocking & Testing:** Unit tests use dependency injection mocks to verify prompt passing, model configuration, error handling, and empty response safety without making network calls or requiring an API key.

---

## Phase 3B: Grounded RAG Answer Generation

### Overview
Phase 3B connects the entire pipeline into the project's **complete end-to-end Retrieval-Augmented Generation (RAG) system** ([`src/answer.ts`](src/answer.ts)):

```text
User Question
      ↓
Query Embedding (Phase 2B-G, Gemini)
      ↓
Vector Search (Phase 2C)
      ↓
Relevant Code Chunks (Phase 2D)
      ↓
Context Builder (Phase 2D)
      ↓
Prompt Construction (Phase 3B)
      ↓
Gemini LLM (Phase 3A, gemini-2.5-flash)
      ↓
Grounded Answer
```

### Key Principles & Behavior
1. **Strict Repository Grounding**: The constructed prompt instructs the LLM that the retrieved repository context is the primary source of truth. The LLM must not invent nonexistent files, symbols, APIs, or behaviors.
2. **Safe Empty Retrieval Handling**: If semantic search returns no relevant code chunks (or character limits exclude all chunks), the orchestrator immediately returns a clear message stating that no relevant context was found rather than calling the LLM or hallucinating evidence.
3. **Dependency Injection**: The orchestrator accepts an [`LLMClient`](src/llm.ts) interface and `retrieveOptions`, allowing deterministic unit tests to run with mock embedding and LLM providers (zero API calls and zero latency).
4. **Focused Scope**: The system currently **answers questions about retrieved repository code**. It does **not** edit code, generate diffs, or execute changes.

---

## Data Structures

### EmbeddingClient & GeminiEmbeddingClient (Phase 2B-G)
```ts
export interface EmbeddingClient {
  embedTexts(inputs: string[]): Promise<number[][]>;
}

export interface GenerateEmbeddingsOptions {
  apiKey?: string;
  model?: string;
  batchSize?: number;
  client?: EmbeddingClient;
}
```

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

### LLMClient & GeminiClientOptions (Phase 3A)
```ts
export interface LLMClient {
  generateText(prompt: string): Promise<string>;
}

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  sdkClient?: GeminiSdkClient;
}
```

### AnswerResult & RetrieveAndAnswerOptions (Phase 3B)
```ts
export interface AnswerResult {
  answer: string;
  retrievedChunks: number;
  contextCharacters: number;
  question?: string;
  retrievedResults?: RetrievedChunk[];
}

export interface RetrieveAndAnswerOptions {
  llmClient: LLMClient;
  retrieveOptions?: RetrieveOptions;
  contextOptions?: BuildContextOptions;
}
```

---

## Scripts & Usage

### 1. View Code Chunks (Phase 2A)
```bash
npm start
```

### 2. View Embedding Pipeline (Phase 2B-G)
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

### 6. Grounded Question Answering with RAG (Phase 3B)
```bash
npm run ask -- "Where is authentication handled?"
```

Example Answer Output:
```text
==========================================
RAG Answer Generation (Phase 3B)
==========================================

Question:
Where is authentication handled?

Retrieving repository context and generating grounded answer...

==========================================
Answer:
==========================================

Authentication is handled in `sample-repo/auth.js` within the `AuthService` class and related helper functions:

- `AuthService` (lines 9-13): Defines the class responsible for authentication. Its `login(user)` method delegates token creation to `generateToken(user)`.
- `generateToken(user)` (lines 1-3): Creates a JSON Web Token signed with `SECRET` containing the user's ID payload.
- `verifyToken(token)` (lines 5-7): Verifies tokens using `jwt.verify(token, SECRET)`.

(Retrieved 2 chunk(s), 498 context characters)
```

### 7. Run Automated Tests
Runs all unit and integration tests (zero network calls, zero API key required):
```bash
npm test
```

### 8. Type Check
```bash
npx tsc --noEmit
```