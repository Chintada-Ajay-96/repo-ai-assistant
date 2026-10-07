import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { type CodeChunk } from "../src/codeChunks.js";
import { type EmbeddingClient } from "../src/embeddings.js";
import { VectorStore } from "../src/vectorStore.js";
import {
  retrieveRelevantCode,
  buildContext,
  formatSingleChunkContext,
  formatScore,
  type RetrievedChunk,
  type RetrievalResult,
} from "../src/retrieval.js";

describe("retrieval - Retrieval & RAG Context Preparation (Phase 2D)", () => {
  const chunkA: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "login",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function login() {\n  return true;\n}",
  };

  const chunkB: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "logout",
    type: "method",
    parent: "AuthService",
    startLine: 10,
    endLine: 12,
    code: "logout() {\n  return false;\n}",
  };

  const chunkC: CodeChunk = {
    file: "math.js",
    language: "javascript",
    symbol: "add",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function add(a, b) {\n  return a + b;\n}",
  };

  function createMockEmbeddingClient(vector: number[]): EmbeddingClient {
    return {
      async embedTexts(inputs: string[]) {
        return inputs.map(() => vector);
      },
    };
  }

  function setupTestStore(): VectorStore {
    const store = new VectorStore();
    // chunkA vector: [1, 0, 0] -> cosine similarity with query [1, 0, 0] is 1.0
    store.add({ chunk: chunkA, embedding: [1, 0, 0] });
    // chunkB vector: [0.8, 0.6, 0] -> cosine similarity with query [1, 0, 0] is 0.8
    store.add({ chunk: chunkB, embedding: [0.8, 0.6, 0] });
    // chunkC vector: [0, 1, 0] -> cosine similarity with query [1, 0, 0] is 0.0
    store.add({ chunk: chunkC, embedding: [0, 1, 0] });
    return store;
  }

  describe("retrieveRelevantCode", () => {
    it("should successfully retrieve relevant code chunks", async () => {
      const store = setupTestStore();
      const mockClient = createMockEmbeddingClient([1, 0, 0]);

      const result = await retrieveRelevantCode("how to login", {
        store,
        client: mockClient,
      });

      assert.equal(result.query, "how to login");
      assert.equal(result.results.length, 3);
      assert.equal(result.results[0]!.chunk.symbol, "login");
      assert.ok(Math.abs(result.results[0]!.score - 1.0) < 1e-6);
    });

    it("should respect topK parameter", async () => {
      const store = setupTestStore();
      const mockClient = createMockEmbeddingClient([1, 0, 0]);

      const result = await retrieveRelevantCode("authentication", {
        store,
        client: mockClient,
        topK: 2,
      });

      assert.equal(result.results.length, 2);
      assert.equal(result.results[0]!.chunk.symbol, "login");
      assert.equal(result.results[1]!.chunk.symbol, "logout");
    });

    it("should preserve result ranking order from highest to lowest score", async () => {
      const store = setupTestStore();
      const mockClient = createMockEmbeddingClient([1, 0, 0]);

      const result = await retrieveRelevantCode("query", {
        store,
        client: mockClient,
      });

      assert.equal(result.results.length, 3);
      assert.ok(result.results[0]!.score >= result.results[1]!.score);
      assert.ok(result.results[1]!.score >= result.results[2]!.score);
      assert.equal(result.results[0]!.chunk.symbol, "login");
      assert.equal(result.results[1]!.chunk.symbol, "logout");
      assert.equal(result.results[2]!.chunk.symbol, "add");
    });

    it("should handle empty vector store gracefully", async () => {
      const emptyStore = new VectorStore();
      const mockClient = createMockEmbeddingClient([1, 0, 0]);

      const result = await retrieveRelevantCode("any query", {
        store: emptyStore,
        client: mockClient,
      });

      assert.equal(result.query, "any query");
      assert.equal(result.results.length, 0);
    });

    it("should fail clearly when vector store file is missing", async () => {
      const missingPath = path.join("fixtures", "nonexistent-store.json");
      await assert.rejects(
        async () => {
          await retrieveRelevantCode("query", {
            storePath: missingPath,
            client: createMockEmbeddingClient([1, 0, 0]),
          });
        },
        /Vector store file not found/
      );
    });

    it("should fail clearly when API key is missing and no client is provided", async () => {
      const originalApiKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      const store = setupTestStore();

      try {
        await assert.rejects(
          async () => {
            await retrieveRelevantCode("query", { store });
          },
          /Missing Gemini API key/
        );
      } finally {
        if (originalApiKey !== undefined) {
          process.env.GEMINI_API_KEY = originalApiKey;
        }
      }
    });

    it("should propagate embedding provider errors clearly", async () => {
      const store = setupTestStore();
      const failingClient: EmbeddingClient = {
        async embedTexts() {
          throw new Error("Provider rate limit exceeded");
        },
      };

      await assert.rejects(
        async () => {
          await retrieveRelevantCode("query", {
            store,
            client: failingClient,
          });
        },
        /Failed to generate query embedding from provider: Provider rate limit exceeded/
      );
    });

    it("should reject invalid query", async () => {
      const store = setupTestStore();
      await assert.rejects(
        async () => {
          await retrieveRelevantCode("", { store });
        },
        /Query cannot be empty/
      );
      await assert.rejects(
        async () => {
          await retrieveRelevantCode("   ", { store });
        },
        /Query cannot be empty/
      );
    });

    it("should reject invalid topK values", async () => {
      const store = setupTestStore();
      const mockClient = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await retrieveRelevantCode("test", { store, client: mockClient, topK: 0 });
        },
        /topK must be a positive integer/
      );

      await assert.rejects(
        async () => {
          await retrieveRelevantCode("test", { store, client: mockClient, topK: -3 });
        },
        /topK must be a positive integer/
      );

      await assert.rejects(
        async () => {
          await retrieveRelevantCode("test", { store, client: mockClient, topK: 1.5 });
        },
        /topK must be a positive integer/
      );
    });
  });

  describe("buildContext", () => {
    const sampleResults: RetrievedChunk[] = [
      {
        chunk: chunkA,
        score: 0.95,
      },
      {
        chunk: chunkB,
        score: 0.85,
      },
    ];

    it("should include file path in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("File: auth.js"));
    });

    it("should include symbol name in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("Symbol: login"));
      assert.ok(context.includes("Symbol: logout"));
    });

    it("should include symbol type in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("Type: function"));
      assert.ok(context.includes("Type: method"));
    });

    it("should include line numbers in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("Lines: 1-3"));
      assert.ok(context.includes("Lines: 10-12"));
    });

    it("should include parent class when available, and omit it when absent", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("Parent: AuthService"));

      // Single chunk without parent
      const singleWithoutParent = buildContext([sampleResults[0]!]);
      assert.equal(singleWithoutParent.context.includes("Parent:"), false);
    });

    it("should include source code in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("function login() {"));
      assert.ok(context.includes("logout() {"));
    });

    it("should include similarity score in formatted context", () => {
      const { context } = buildContext(sampleResults);
      assert.ok(context.includes("Similarity: 0.95"));
      assert.ok(context.includes("Similarity: 0.85"));
    });

    it("should accept a RetrievalResult object as input", () => {
      const retrieval: RetrievalResult = {
        query: "auth",
        results: sampleResults,
      };
      const { context, includedChunks } = buildContext(retrieval);
      assert.equal(includedChunks, 2);
      assert.ok(context.includes("Symbol: login"));
    });

    it("should handle empty results gracefully", () => {
      const result = buildContext([]);
      assert.equal(result.context, "");
      assert.equal(result.includedChunks, 0);
      assert.equal(result.totalCharacters, 0);
    });

    it("should provide accurate context metadata", () => {
      const result = buildContext(sampleResults);
      assert.equal(result.includedChunks, 2);
      assert.equal(result.totalCharacters, result.context.length);
      assert.ok(result.totalCharacters > 0);
    });

    it("should enforce context maxCharacters limit", () => {
      // Chunk A formatted block is around 180-220 characters with separators
      const full = buildContext(sampleResults);
      const limit = Math.floor(full.totalCharacters * 0.7);

      const constrained = buildContext(sampleResults, { maxCharacters: limit });
      assert.ok(constrained.totalCharacters <= limit);
      assert.equal(constrained.includedChunks, 1);
      assert.ok(constrained.context.includes("Symbol: login"));
      assert.equal(constrained.context.includes("Symbol: logout"), false);
    });

    it("should adhere to complete-chunk behavior (never cut chunks in the middle)", () => {
      // Limit smaller than chunk 1 plus chunk 2, but larger than chunk 1
      const block1 = formatSingleChunkContext(sampleResults[0]!);
      const minLimit = block1.length + 120; // Enough for chunk 1 + delimiters, but not chunk 2

      const result = buildContext(sampleResults, { maxCharacters: minLimit });
      assert.equal(result.includedChunks, 1);
      // Chunk 1 code is fully present
      assert.ok(result.context.includes("function login() {\n  return true;\n}"));
      // Chunk 2 code is completely absent, not partially sliced
      assert.equal(result.context.includes("logout()"), false);

      // If limit is even smaller than chunk 1 itself:
      const tinyResult = buildContext(sampleResults, { maxCharacters: 50 });
      assert.equal(tinyResult.includedChunks, 0);
      assert.equal(tinyResult.context, "");
      assert.equal(tinyResult.totalCharacters, 0);
    });

    it("should preserve ranking order when considering chunks for inclusion", () => {
      const ranked: RetrievedChunk[] = [
        { chunk: chunkA, score: 0.99 },
        { chunk: chunkB, score: 0.80 },
        { chunk: chunkC, score: 0.50 },
      ];

      const result = buildContext(ranked);
      assert.equal(result.includedChunks, 3);
      const posA = result.context.indexOf("Symbol: login");
      const posB = result.context.indexOf("Symbol: logout");
      const posC = result.context.indexOf("Symbol: add");

      assert.ok(posA < posB);
      assert.ok(posB < posC);
    });

    it("should safely remove duplicate chunks based on stable chunk identity", () => {
      const duplicates: RetrievedChunk[] = [
        { chunk: chunkA, score: 0.95 },
        { chunk: chunkA, score: 0.90 }, // duplicate chunkA
        { chunk: chunkB, score: 0.85 },
        { chunk: chunkA, score: 0.70 }, // duplicate chunkA
      ];

      const result = buildContext(duplicates);
      assert.equal(result.includedChunks, 2);

      // Verify chunkA only appears once
      const occurrences = (result.context.match(/Symbol: login/g) || []).length;
      assert.equal(occurrences, 1);
    });

    it("should reject invalid maxCharacters values", () => {
      assert.throws(() => {
        buildContext(sampleResults, { maxCharacters: 0 });
      }, /maxCharacters must be a positive number/);

      assert.throws(() => {
        buildContext(sampleResults, { maxCharacters: -100 });
      }, /maxCharacters must be a positive number/);
    });

    it("should format scores cleanly", () => {
      assert.equal(formatScore(0.87), "0.87");
      assert.equal(formatScore(0.875), "0.875");
      assert.equal(formatScore(0.87654), "0.8765");
      assert.equal(formatScore(1), "1");
      assert.equal(formatScore(0), "0");
      assert.equal(formatScore(NaN), "0");
    });
  });
});
