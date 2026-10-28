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
       │
       ▼
Phase 4:
Read-Only Code Change Assistance (Target Analysis → Diff Generation → Tree-sitter AST Syntax Check)
       │
       ▼
Phase 5A:
Candidate Test Discovery & Multi-Tier Ranking
       │
       ▼
Phase 5B:
Isolated Docker-based Code Verification & Status Withholding
```

```
Repository Root
       │
       ▼
src/utils/walkRepo.ts    ──► Recursive directory discovery (.js, .jsx, .ts, .tsx)
       │
       ▼
src/repoMap.ts           ──► Tree-sitter AST parsing & symbol extraction
       │
       ▼
src/codeChunks.ts        ──► Semantic code chunking with line preservation
       │
       ▼
src/embeddings.ts        ──► Gemini embedding generation (gemini-embedding-001)
       │                     ├── Provider-independent EmbeddingClient interface
       │                     ├── Official Google Gen AI SDK (@google/genai)
       │                     ├── Configurable batching & ordering preservation
       │                     └── Query embedding in unified vector space
       │
       ▼
src/vectorStore.ts       ──► Local JSON Vector Store (.data/vector-store.json)
       │                     ├── Persistence (saveToFile / loadFromFile)
       │                     ├── Cosine Similarity: dot(A, B) / (||A|| * ||B||)
       │                     └── Top-K Semantic Search
       │
       ▼
src/retrieval.ts         ──► Retrieval & Context Preparation
       │                     ├── Query embedding & vector store query
       │                     ├── Result deduplication via stable chunk IDs
       │                     ├── Strict character limit budget (maxCharacters)
       │                     └── Structured LLM context formatting
       │
       ▼
src/llm.ts               ──► LLM Text Generation Client (Phase 3A)
       │                     ├── Provider-independent LLMClient interface
       │                     ├── Official Google Gen AI SDK (@google/genai)
       │                     ├── Default Flash model (gemini-2.5-flash)
       │                     └── Safe response handling & error propagation
       │
       ▼
src/answer.ts            ──► Grounded RAG Answer Generation (Phase 3B)
       │                     ├── Query retrieval & context building
       │                     ├── Grounded prompt construction (no hallucinations)
       │                     └── End-to-end answer generation via LLMClient
       │
       ▼
src/changeAnalysis.ts    ──► Target Analysis & Line Verification (Phase 4A)
       │                     ├── Disambiguation & confidence ranking
       │                     └── Baseline disk freshness validation
       │
       ▼
src/changeGenerator.ts   ──► Code Change & Unified Diff Generation (Phase 4B)
       │                     ├── Context-grounded instruction prompting
       │                     └── Gemini Flash replacement generation
       │
       ▼
src/changeValidation.ts  ──► In-Memory Tree-sitter AST Syntax Validation (Phase 4C)
       │                     ├── Dry-run virtual replacement (zero disk writes)
       │                     └── Grammatical AST parse error detection
       │
       ▼
src/testDiscovery.ts     ──► Candidate Test Discovery & Ranking (Phase 5A)
       │                     ├── Multi-tier confidence scoring
       │                     └── Stem, symbol, and folder affinity matching
       │
       ▼
src/verification/        ──► Isolated Docker Verification Orchestrator (Phase 5B)
                             ├── workspaceStager.ts   (Out-of-tree staging in os.tmpdir)
                             ├── commandAllowlist.ts  (Traversal & illegal syntax rejection)
                             ├── dockerSandbox.ts     (Hardened sandbox: --network none, --read-only)
                             ├── tapParser.ts         (Scope-stack TAP v13 machine-readable parser)
                             └── verifier.ts          (Strict status withholding invariant)
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

## Phase 4: Read-Only Code Change Assistance

### Overview
Phase 4 extends the assistant from read-only question answering to **read-only code change proposal and syntactic validation** ([`src/changeAnalysis.ts`](src/changeAnalysis.ts), [`src/changeGenerator.ts`](src/changeGenerator.ts), [`src/changeValidation.ts`](src/changeValidation.ts)):

```text
User Instruction + Optional Target Hints (--file, --symbol)
       ↓
Target Analysis (Phase 4A)
  ├── Semantic ranking & candidate disambiguation
  ├── Line boundary verification & disk freshness validation
  └── Reference context retrieval
       ↓
Code Change Generation (Phase 4B)
  ├── Structured Gemini Flash prompting (gemini-2.5-flash)
  └── Proposed replacement & unified diff generation
       ↓
In-Memory Validation (Phase 4C)
  ├── Virtual replacement simulation (zero host disk writes)
  └── Tree-sitter AST syntax parsing & error detection
       ↓
Structured Change Validation Report
```

### Key Principles & Safety Guarantees
1. **Strictly Read-Only (Dry-Run by Default)**: The engine never writes changes to the repository files on disk. All modifications exist exclusively as in-memory simulations and unified diff previews for human review.
2. **Ambiguity Detection**: If an instruction matches multiple candidate symbols with close similarity scores, the analyzer throws an `AmbiguousTargetError` and prompts the user to supply a `--file` or `--symbol` hint to avoid applying changes to the wrong component.
3. **Stale Index Guard**: If the current code on disk differs from the indexed code in `.data/vector-store.json`, a `StaleIndexError` is thrown, advising the developer to re-index (`npm run index`).
4. **Tree-sitter AST Syntax Validation**:
   - The proposed replacement is virtually spliced into the target file in memory.
   - The spliced source is parsed using the appropriate WebAssembly Tree-sitter grammar (JavaScript, TypeScript, or TSX).
   - The AST is inspected for syntax errors (`rootNode.hasError()`, `ERROR` nodes, `MISSING` nodes).
   - **Important Limitation**: AST syntax validation proves *grammatical validity*. It does **not** guarantee runtime semantic correctness, type safety, or absence of logical bugs.

---

## Phase 5: Candidate Test Discovery & Isolated Docker Verification

### Overview
Phase 5 introduces **isolated, hardened container execution** to verify proposed code changes against real candidate tests without risking the host development environment ([`src/testDiscovery.ts`](src/testDiscovery.ts), [`src/verification/`](src/verification/)):

```text
Validated Change Plan (Phase 4)
       ↓
Candidate Test Discovery (Phase 5A, src/testDiscovery.ts)
  ├── Stem match, symbol reference, directory affinity scoring
  └── Allowlisted test file resolution
       ↓
Out-of-Tree Workspace Staging (Phase 5B, src/verification/workspaceStager.ts)
  ├── Copy allowlisted files to os.tmpdir() (host repo strictly read-only)
  ├── Apply virtual patch to staged copy
  └── No-Op change detection (fails closed if proposed code equals disk)
       ↓
Ephemeral Permission Probe (src/verification/dockerSandbox.ts)
  └── Container UID 1000 write capability verification
       ↓
Hardened Docker Sandbox Execution (src/verification/dockerSandbox.ts)
  ├── --network none (zero network access)
  ├── --pull never (refuses unverified remote image downloads)
  ├── --read-only root filesystem
  ├── --user 1000:1000 (non-root execution)
  ├── --cap-drop ALL (all Linux capabilities dropped)
  ├── --security-opt no-new-privileges:true
  ├── --tmpfs /tmp:rw,noexec,nosuid,size=64m
  ├── Fixed resource limits (memory, CPU, PIDs ceiling)
  └── Execution of approved runner: /node_modules/.bin/tsx --test --test-reporter=tap
       ↓
Machine-Readable TAP v13 Parser (src/verification/tapParser.ts)
  ├── Scope-stack ID reconciliation (no subtest ID collisions)
  ├── Suite wrapper identification (type: 'suite')
  └── Plan count and discrete assertion reconciliation
       ↓
Bounded Asynchronous Cleanup & Status Withholding Invariant (src/verification/verifier.ts)
  ├── Bounded 3-second wait for container stoppage & staging removal
  └── Strict Status Withholding: If cleanup or container stoppage is unconfirmed,
      passing test status is withheld and replaced with ERROR
```

### Docker Security Sandbox Controls
- **`--network none`**: Disables all network interfaces except loopback. Containers cannot communicate with external services or local network devices.
- **`--pull never`**: Prevents the Docker daemon from reaching out to external registries. Only locally built, verified images are permitted.
- **`--read-only`**: The container's root filesystem is mounted read-only.
- **`--user 1000:1000`**: Container processes run as unprivileged user `app` (UID/GID 1000:1000).
- **`--cap-drop ALL`**: Drops all Linux kernel capabilities (`CapEff: 0000000000000000`).
- **`--security-opt no-new-privileges:true`**: Prevents child processes from acquiring additional privileges (`NoNewPrivs: 1`).
- **`--tmpfs /tmp:rw,noexec,nosuid,size=64m`**: Ephemeral `/tmp` mount configured without execution permissions.
- **Resource Ceilings**: Enforces memory limit (`--memory 1024m`), CPU limit (`--cpus 1.0`), and process ceiling (`--pids-limit 64`).
- **Pinned Image ID**: Execution requires an exact 64-character SHA-256 local Image ID (`sha256:...`). Mutable tags are strictly rejected.

### Host Repository Immutability Guarantee
- Staging takes place exclusively inside `os.tmpdir()` in a dedicated directory (`repo-assistant-verify-<uuid>`).
- The host repository is opened in read-only mode during file copying.
- The host repository is never targeted for writing during the verification lifecycle.
- Filesystem changes exist solely inside the temporary staging directory and are cleaned up upon test completion.

### Meaning of Verification Outcomes
| Outcome | Description |
| :--- | :--- |
| **`PASSED`** | Discovered candidate tests executed inside the sandbox and all assertions passed (exit code `0`). |
| **`FAILED`** | One or more test assertions failed, the test runner crashed, or the proposal was detected as a No-Op change. |
| **`TIMED_OUT`** | Test execution exceeded the configured wall-clock timeout (default 30 seconds) and was terminated. |
| **`OUTPUT_LIMIT_EXCEEDED`** | Test output produced runaway stdout/stderr exceeding buffer limit (default 512KB) and was terminated. |
| **`UNAVAILABLE`** | Verification was refused because Docker Desktop is not running, the named pipe is inaccessible, or the image is unprovisioned. Untrusted execution on the host was refused. |
| **`ERROR`** | An operational failure occurred (e.g. invalid change plan, traversal in test path, or failure to confirm workspace cleanup). |

> [!IMPORTANT]
> **Semantic Correctness Disclaimer**: A `PASSED` verification outcome proves that the discovered test assertions ran and passed against the proposed change inside the isolated container. Passing tests do **not** prove that the change is completely correct, bug-free, or free of regressions outside the scope of the executed test suite.

---

## Data Structures (Phases 4 & 5)

### TargetContext, ProposedChange, & ChangeValidationPlan (Phase 4)
```ts
export interface TargetContext {
  instruction: string;
  target: RankedChunk;
  references: RankedChunk[];
  diskContent: string;
}

export interface ProposedChange {
  file: string;
  symbol: string;
  targetFile: string;
  targetSymbol: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  proposedCode: string;
  diff: string;
  explanation: string;
}

export interface ChangeValidationPlan {
  isValid: boolean;
  proposal: ProposedChange;
  checks: ValidationCheckResult[];
  preview: string;
  syntaxNotice: string;
  failureReason?: string;
}
```

### VerificationResult (Phase 5B)
```ts
export interface VerificationResult {
  status: "passed" | "failed" | "timed_out" | "output_limit_exceeded" | "unavailable" | "error";
  environment: "docker" | "none";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
  command?: ApprovedTestCommand;
  executionSummary?: TestExecutionSummary;
  cleanupStatus: "cleaned" | "failed" | "not_applicable";
  failureReason?: string;
  warnings: string[];
  securityNotice: string;
  semanticDisclaimer: string;
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

### 7. Propose & Validate Code Changes (Phase 4)

Generate a read-only code change proposal with unified diff and in-memory Tree-sitter AST syntax validation:

```powershell
npx tsx src/index.ts --propose "Add a null check to verifyToken" --file sample-repo/auth.js --symbol verifyToken
```

> [!TIP]
> **Windows PowerShell Flag Forwarding**: On Windows PowerShell, invoke commands directly via `npx tsx src/index.ts` rather than `npm run propose -- ...`. The npm wrapper on Windows can swallow or misparse secondary flags (`--file`, `--symbol`, `--verify`), whereas direct `npx tsx` invocation guarantees deterministic argument forwarding.

Real CLI Output:
```text
==========================================
Code Change Assistance (Phase 4)
==========================================

Instruction:
Add a null check to verifyToken
Target File Hint: sample-repo/auth.js
Target Symbol Hint: verifyToken

1. Analyzing repository and identifying target symbol...
   ✓ Target identified: sample-repo/auth.js :: verifyToken (function, lines 5-7)
   ✓ Source verified against disk (similarity: 0.6833)
   ✓ Retrieved 3 reference context chunk(s)

2. Generating proposed replacement with Gemini (gemini-2.5-flash)...
   ✓ Proposed replacement and unified diff generated.

3. Validating proposed change and verifying Tree-sitter AST syntax...

==================================================
CHANGE VALIDATION REPORT
==================================================
Target: sample-repo/auth.js :: verifyToken (lines 5-7)
Status: PASSED (Ready for review)

CHECKLIST:
  [PASS] File Existence: File exists on disk: sample-repo/auth.js
  [PASS] Line Boundaries: Lines 5-7 within file bounds (13 lines total)
  [PASS] Source Freshness: Current disk content matches proposed baseline exactly
  [PASS] Grammar Support: Supported language (javascript, grammar: javascript)
  [PASS] AST Syntax: Tree-sitter AST parsed successfully without syntax errors (grammatical validity confirmed; does not prove semantic correctness).

PROPOSED UNIFIED DIFF:
--- sample-repo/auth.js (original)
+++ sample-repo/auth.js (proposed)
@@ -5,3 +5,6 @@
 function verifyToken(token) {
+  if (!token) {
+    throw new Error('Verification failed: Token is missing.');
+  }
   return jwt.verify(token, SECRET);
 }

EXPLANATION:
Added a null check at the beginning of the `verifyToken` function. If the `token` argument is null or undefined, an `Error` is thrown, preventing `jwt.verify` from being called with invalid input and providing a clearer error message.

NOTICE:
Notice: Syntax validation confirms grammatical validity with Tree-sitter AST, but does not guarantee semantic correctness, runtime behavior, or type safety.

==========================================
Summary: Proposed change is syntactically valid and ready for review.
Notice: This was a dry-run. No files on disk were modified.
==========================================
```

---

### 8. Isolated Docker Behavioral Verification (Phase 5B)

Propose a code change and run candidate test discovery with isolated Docker sandbox verification:

```powershell
npx tsx src/index.ts --propose "Trim whitespace and replace backslashes in normalizePath" --file src/utils/walkRepo.ts --symbol normalizePath --verify
```

#### Prerequisites for Docker Verification
1. **Docker Desktop for Windows**: Must be installed and running with the Linux container engine (WSL 2 backend). Verification validates and explicitly binds all Docker CLI operations to the local engine named pipe (`-H npipe:////./pipe/dockerDesktopLinuxEngine` or `npipe:////./pipe/docker_engine`), completely bypassing any active or remote Docker context.
2. **Provisioned Local Image**: The verified verification image must be built locally and provisioned in [`src/verification/imageConfig.ts`](src/verification/imageConfig.ts):
   - **Image Tag**: `repo-assistant-verifier:local`
   - **Pinned Digest**: `sha256:6a9bed5b4d4aac85721541f4cd421a49adc57d116a7da7916c1512b244da11ef`

#### Real Passing Verification CLI Output (In Isolated Container)
When the proposal is within the staging allowlist (`src/`) and candidate tests are discovered, verification executes inside the hardened Docker container:

```text
==========================================
Code Change Assistance (Phase 4)
==========================================

Instruction:
Trim whitespace and replace backslashes in normalizePath
Target File Hint: src/utils/walkRepo.ts
Target Symbol Hint: normalizePath

1. Analyzing repository and identifying target symbol...
   ✓ Target identified: src/utils/walkRepo.ts :: normalizePath (function, lines 16-18)
   ✓ Source verified against disk (similarity: 0.7430)
   ✓ Retrieved 9 reference context chunk(s)

2. Generating proposed replacement with Gemini (gemini-2.5-flash)...
   ✓ Proposed replacement and unified diff generated.

3. Validating proposed change and verifying Tree-sitter AST syntax...

==================================================
CHANGE VALIDATION REPORT
==================================================
Target: src/utils/walkRepo.ts :: normalizePath (lines 16-18)
Status: PASSED (Ready for review)

CHECKLIST:
  [PASS] File Existence: File exists on disk: src/utils/walkRepo.ts
  [PASS] Line Boundaries: Lines 16-18 within file bounds (93 lines total)
  [PASS] Source Freshness: Current disk content matches proposed baseline exactly
  [PASS] Grammar Support: Supported language (typescript, grammar: typescript)
  [PASS] AST Syntax: Tree-sitter AST parsed successfully without syntax errors (grammatical validity confirmed; does not prove semantic correctness).

PROPOSED UNIFIED DIFF:
--- src/utils/walkRepo.ts (original)
+++ src/utils/walkRepo.ts (proposed)
@@ -16,3 +16,3 @@
 export function normalizePath(filePath: string): string {
-  return filePath.replace(/\\/g, "/");
+  return filePath.trim().replace(/\\/g, "/");
 }

EXPLANATION:
Added `.trim()` to the `filePath` before performing the backslash replacement, ensuring that any leading or trailing whitespace is removed from the path string.

NOTICE:
Notice: Syntax validation confirms grammatical validity with Tree-sitter AST, but does not guarantee semantic correctness, runtime behavior, or type safety.

==========================================
Summary: Proposed change is syntactically valid and ready for review.
Notice: This was a dry-run. No files on disk were modified.
==========================================

4. Running isolated behavioral verification (Phase 5B)...
   ✓ Discovered 20 candidate test(s)

==========================================
Verification Status: PASSED
==========================================
Tests: 8 passed, 0 failed, 0 skipped, 0 todo (8 total)
Cleanup: cleaned

Security Notice: Verification was executed inside a hardened Docker container pinned by verified Image ID. Network was disabled (--network none), root filesystem was read-only, capabilities were dropped, and resource ceilings were enforced. The host repository was not modified.

Notice: Passing candidate tests confirms that existing assertions in the tested suites succeeded against the proposed code. It does NOT guarantee complete functional correctness, absence of regressions in untested paths, or total system security.
```

#### Real Fail-Closed CLI Output (When Docker Desktop is Stopped)
When Docker Desktop is offline, the verification runner refuses to run untrusted code on the host system and safely fails closed:

```text
==========================================
Verification Status: UNAVAILABLE
==========================================
Details: Docker endpoint validation failed: Neither \\.\pipe\dockerDesktopLinuxEngine nor \\.\pipe\docker_engine is accessible. Verification requires a running local Docker Desktop engine.
Cleanup: not_applicable

Security Notice: Verification was refused because the required local Docker Desktop named pipe, verified image, or permissions were not available. Untrusted test execution on the host was refused.

Notice: Behavioral verification could not be executed or workspace cleanup could not be confirmed. Test pass/fail status is unknown or withheld.
```

---

### 9. Automated Test Matrix vs. Live End-to-End Demo

To ensure absolute transparency and engineering rigor, the capabilities of Repo Assistant are divided between automated test suite coverage and live end-to-end execution:

| Verification Mode | Scope & Components | Execution Conditions |
| :--- | :--- | :--- |
| **Automated Unit & Integration Tests (`npm test`)** | 285 automated tests across 14 suites:<br>• 271 unit tests covering chunking, vector math, RAG prompt construction, Tree-sitter AST parsing, test discovery heuristics, command allowlists, out-of-tree staging, and TAP parsing.<br>• 14 live Docker integration tests covering live container security invariants (`--network none`, `--read-only`, `--cap-drop ALL`, non-root UID 1000, canary mounts, timeout termination, bounded cleanup). | • Unit tests require **zero external dependencies**, no API key, and run in milliseconds.<br>• Docker integration tests run when Docker Desktop Linux engine is active. |
| **Live Interactive End-to-End Demo** | Live execution across all 5 phases:<br>• Phase 1 & 2: Repository walking, AST symbol chunking, live Gemini embeddings (`npm run embed`), and persistent vector indexing (`npm run index`).<br>• Phase 2C & 2D: Live semantic search (`npm run search`) and token-budgeted RAG context assembly (`npm run retrieve`).<br>• Phase 3B: Grounded question answering with live `gemini-2.5-flash` (`npm run ask`).<br>• Phase 4: Live code change proposal with unified diff and Tree-sitter AST validation (`--propose`).<br>• Phase 5B: Live candidate test discovery and Docker behavioral verification (`--verify`). | Requires active `GEMINI_API_KEY` in environment/.env file, and active Docker Desktop Linux daemon for live container execution. |

---

### 10. Run Full Test Suite

Runs all automated test suites:

```powershell
npm test
```

### 11. Type Check

Verifies TypeScript compilation across the entire codebase without emitting build artifacts:

```powershell
npx tsc --noEmit
```