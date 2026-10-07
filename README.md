# Repository AI Assistant

A lightweight, reliable repository analysis and code chunking engine inspired by Cursor/Copilot-style systems. It indexes source code by extracting syntactic symbols using WebAssembly-based Tree-sitter grammars and produces semantic code chunks.

---

## Architecture Pipeline

```text
Phase 1:
Repository → AST → Symbols
       │
       ▼
Phase 2A:
Symbols → Code Chunks
```

```
Repository Root
       │
       ▼
src/utils/walkRepo.ts  ──► Recursive directory discovery
       │                   (Filters node_modules, .git, dist, build)
       │                   (Detects language from extension)
       ▼
src/repoMap.ts         ──► Tree-sitter WASM loading & parser caching
       │                   (JavaScript, TypeScript, and TSX grammars)
       ▼
AST Traversal          ──► Recursive syntax tree traversal & symbol extraction
       │                   (Preserves hierarchy, parent classes, line numbers)
       ▼
Repository Map         ──► Structured symbol list per file
       │
       ▼
src/codeChunks.ts      ──► Exact line extraction & chunk creation
       │                   (Extracts source code lines, deduplicates, preserves context)
       ▼
Code Chunks            ──► Meaningful, retrieval-ready code chunks
```

---

## Why Code Chunking (Phase 2A)?

In standard text search or basic RAG, documents are often chunked using arbitrary character or token windows (e.g. 500 characters). For source code, window-based chunking is problematic because:
1. It cuts functions, classes, or control flow in half, breaking syntax and semantic coherence.
2. It loses essential symbol context such as class ownership, symbol names, and start/end line bounds.

**Symbol-based Code Chunking** solves this:
- **Syntactic Boundaries**: Every chunk corresponds to an actual semantic unit (a full function, class, method, or interface).
- **Rich Metadata**: Chunks retain `file`, `language`, `symbol`, `type`, `startLine`, `endLine`, and `parent`.
- **Retrieval-Ready**: When embedding and vector search are added, retrieved chunks provide complete, compilable, and self-contained code contexts for the LLM.

---

## Supported File Types

| File Extension | Language | Tree-sitter Grammar |
|---|---|---|
| `.js` | JavaScript | `javascript` |
| `.jsx` | JavaScript | `javascript` |
| `.ts` | TypeScript | `typescript` |
| `.tsx` | TypeScript | `tsx` |

---

## Extracted Symbols & Chunks

| Symbol Type | Code Construct | Metadata Captured |
|---|---|---|
| `function` | Function declarations, generator functions, assigned function expressions | `symbol`, `type`, `startLine`, `endLine`, `code`, `parent`? |
| `arrow_function` | Arrow functions assigned to variables/constants or class fields | `symbol`, `type`, `startLine`, `endLine`, `code`, `parent`? |
| `class` | Standard classes and TypeScript `abstract` classes | `symbol`, `type`, `startLine`, `endLine`, `code` |
| `method` | Class methods (regular, static, getters, setters) | `symbol`, `type`, `startLine`, `endLine`, `code`, `parent` |
| `constructor` | Class constructors | `symbol`, `type`, `startLine`, `endLine`, `code`, `parent` |
| `interface` | TypeScript interfaces | `symbol`, `type`, `startLine`, `endLine`, `code` |
| `type_alias` | TypeScript type aliases | `symbol`, `type`, `startLine`, `endLine`, `code` |

---

## Code Chunk Structure

```ts
export interface CodeChunk {
  file: string;
  language: string;
  symbol: string;
  type: string;
  startLine: number;
  endLine: number;
  code: string;
  parent?: string;
}
```

---

## Scripts & Usage

### 1. Run Chunk Generator

Analyze the default sample repository and view the extracted chunks:
```bash
npm start
```

Or pass a custom directory:
```bash
npx tsx src/index.ts path/to/your/repo
```

### 2. Run Tests

Run the test suite using Node's native test runner via `tsx`:
```bash
npm test
```

### 3. Type Check

```bash
npx tsc --noEmit
```

---

## Example Output

Running `npm start` on `sample-repo` produces:

```text
Generated 4 code chunk(s) for "sample-repo":

--- [FUNCTION] generateToken (sample-repo/auth.js:1-3) ---
function generateToken(user) {
  return jwt.sign({ id: user.id }, SECRET);
}

--- [FUNCTION] verifyToken (sample-repo/auth.js:5-7) ---
function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

--- [CLASS] AuthService (sample-repo/auth.js:9-13) ---
class AuthService {
  login(user) {
    return generateToken(user);
  }
}

--- [METHOD] login (parent: AuthService) (sample-repo/auth.js:10-12) ---
  login(user) {
    return generateToken(user);
  }
```