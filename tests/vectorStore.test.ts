import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  cosineSimilarity,
  getChunkId,
  VectorStore,
  searchCode,
  indexRepository,
  type VectorRecord,
} from "../src/vectorStore.js";
import { type CodeChunk } from "../src/codeChunks.js";
import { type EmbeddingClient } from "../src/embeddings.js";

describe("vectorStore - Vector Storage & Semantic Search (Phase 2C)", () => {
  const tempTestDir = path.join("tests", "fixtures", ".test_data");
  const tempStoreFile = path.join(tempTestDir, "test-vector-store.json");

  const chunkA: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "login",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function login() {}",
  };

  const chunkB: CodeChunk = {
    file: "math.js",
    language: "javascript",
    symbol: "add",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function add() {}",
  };

  const chunkC: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "logout",
    type: "function",
    startLine: 5,
    endLine: 7,
    code: "function logout() {}",
  };

  describe("Cosine Similarity", () => {
    it("should return 1.0 for identical vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      const sim = cosineSimilarity(a, b);
      assert.ok(Math.abs(sim - 1.0) < 1e-6);
    });

    it("should return 0.0 for orthogonal vectors", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      const sim = cosineSimilarity(a, b);
      assert.equal(sim, 0.0);
    });

    it("should return -1.0 for opposite vectors", () => {
      const a = [1, 2];
      const b = [-1, -2];
      const sim = cosineSimilarity(a, b);
      assert.ok(Math.abs(sim - (-1.0)) < 1e-6);
    });

    it("should handle zero-magnitude vectors gracefully without NaN", () => {
      const zero = [0, 0, 0];
      const regular = [1, 2, 3];
      assert.equal(cosineSimilarity(zero, regular), 0.0);
      assert.equal(cosineSimilarity(zero, zero), 0.0);
    });

    it("should handle empty vectors gracefully", () => {
      assert.equal(cosineSimilarity([], []), 0.0);
    });

    it("should throw clear error on vector dimension mismatch", () => {
      const a = [1, 2];
      const b = [1, 2, 3];
      assert.throws(
        () => cosineSimilarity(a, b),
        /Vector dimension mismatch: vector A has length 2, but vector B has length 3/
      );
    });
  });

  describe("VectorStore In-Memory Operations", () => {
    it("should store and retrieve vectors with unique IDs", () => {
      const store = new VectorStore();
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });
      store.add({ chunk: chunkB, embedding: [0, 1, 0] });

      assert.equal(store.size(), 2);
      const records = store.getRecords();
      assert.equal(records.length, 2);

      const idA = getChunkId(chunkA);
      const retrievedA = store.get(idA);
      assert.ok(retrievedA);
      assert.equal(retrievedA.chunk.symbol, "login");
    });

    it("should upsert records with duplicate IDs without duplicating store size", () => {
      const store = new VectorStore();
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });
      // Same chunk, updated embedding
      store.add({ chunk: chunkA, embedding: [0.9, 0.1, 0] });

      assert.equal(store.size(), 1);
      const record = store.get(getChunkId(chunkA));
      assert.deepEqual(record?.embedding, [0.9, 0.1, 0]);
    });

    it("should clear stored vectors", () => {
      const store = new VectorStore();
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });
      assert.equal(store.size(), 1);

      store.clear();
      assert.equal(store.size(), 0);
      assert.deepEqual(store.getRecords(), []);
    });

    it("should return empty array when searching an empty store", () => {
      const store = new VectorStore();
      const results = store.search([1, 0, 0], 5);
      assert.deepEqual(results, []);
    });

    it("should validate query vector and topK parameters", () => {
      const store = new VectorStore();
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });

      // Empty query embedding
      assert.throws(() => store.search([], 5), /Query embedding must be a non-empty array/);

      // Invalid topK
      assert.throws(() => store.search([1, 0, 0], 0), /topK must be a positive integer/);
      assert.throws(() => store.search([1, 0, 0], -1), /topK must be a positive integer/);
      assert.throws(() => store.search([1, 0, 0], 1.5), /topK must be a positive integer/);
    });
  });

  describe("Semantic Search & Top-K Ranking", () => {
    it("should rank results by cosine similarity score descending", () => {
      const store = new VectorStore();
      // Query target: [1, 0, 0]
      // chunkA has perfect match [1, 0, 0] (score ~ 1.0)
      // chunkC has partial match [0.7071, 0.7071, 0] (score ~ 0.7071)
      // chunkB has orthogonal match [0, 1, 0] (score ~ 0.0)
      store.add({ chunk: chunkB, embedding: [0, 1, 0] });
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });
      store.add({ chunk: chunkC, embedding: [0.7071, 0.7071, 0] });

      const results = store.search([1, 0, 0], 3);
      assert.equal(results.length, 3);

      assert.equal(results[0]?.chunk.symbol, "login");
      assert.ok(Math.abs(results[0]!.score - 1.0) < 1e-4);

      assert.equal(results[1]?.chunk.symbol, "logout");
      assert.ok(Math.abs(results[1]!.score - 0.7071) < 1e-4);

      assert.equal(results[2]?.chunk.symbol, "add");
      assert.ok(Math.abs(results[2]!.score - 0.0) < 1e-4);

      // Verify SearchResult contains only chunk and score, without embedding vector
      assert.equal((results[0] as any).embedding, undefined);
      assert.deepEqual(Object.keys(results[0]!).sort(), ["chunk", "score"]);
    });

    it("should limit results to topK", () => {
      const store = new VectorStore();
      store.add({ chunk: chunkA, embedding: [1, 0, 0] });
      store.add({ chunk: chunkB, embedding: [0.5, 0.5, 0] });
      store.add({ chunk: chunkC, embedding: [0, 1, 0] });

      const top1 = store.search([1, 0, 0], 1);
      assert.equal(top1.length, 1);
      assert.equal(top1[0]?.chunk.symbol, "login");

      const top2 = store.search([1, 0, 0], 2);
      assert.equal(top2.length, 2);
    });
  });

  describe("File Persistence (saveToFile / loadFromFile)", () => {
    it("should persist store to JSON and reload exact records", async () => {
      try {
        const store = new VectorStore();
        store.add({ chunk: chunkA, embedding: [0.1, 0.2, 0.3] });
        store.add({ chunk: chunkB, embedding: [0.4, 0.5, 0.6] });

        await store.saveToFile(tempStoreFile);
        assert.ok(fs.existsSync(tempStoreFile), "File should be created on disk");

        // Load into new store instance
        const loadedStore = new VectorStore();
        await loadedStore.loadFromFile(tempStoreFile);

        assert.equal(loadedStore.size(), 2);
        const recordA = loadedStore.get(getChunkId(chunkA));
        assert.ok(recordA);
        assert.equal(recordA.chunk.symbol, "login");
        assert.deepEqual(recordA.embedding, [0.1, 0.2, 0.3]);

        // Search on loaded store
        const searchResults = loadedStore.search([0.1, 0.2, 0.3], 1);
        assert.equal(searchResults[0]?.chunk.symbol, "login");
        assert.ok(Math.abs(searchResults[0]!.score - 1.0) < 1e-6);
      } finally {
        if (fs.existsSync(tempStoreFile)) {
          fs.unlinkSync(tempStoreFile);
        }
        if (fs.existsSync(tempTestDir)) {
          fs.rmdirSync(tempTestDir);
        }
      }
    });

    it("should throw clear error when loading from non-existent file", async () => {
      const store = new VectorStore();
      await assert.rejects(
        async () => {
          await store.loadFromFile("non/existent/vector-store.json");
        },
        /Vector store file not found/
      );
    });

    it("should throw clear error on malformed JSON file", async () => {
      const brokenFile = path.join("tests", "fixtures", "invalid-store.json");
      try {
        fs.writeFileSync(brokenFile, "{ broken json content");
        const store = new VectorStore();
        await assert.rejects(
          async () => {
            await store.loadFromFile(brokenFile);
          },
          /Malformed vector store JSON/
        );
      } finally {
        if (fs.existsSync(brokenFile)) {
          fs.unlinkSync(brokenFile);
        }
      }
    });

    it("should throw clear error on invalid schema (missing records)", async () => {
      const invalidSchemaFile = path.join("tests", "fixtures", "missing-records.json");
      try {
        fs.writeFileSync(invalidSchemaFile, JSON.stringify({ version: 1 }));
        const store = new VectorStore();
        await assert.rejects(
          async () => {
            await store.loadFromFile(invalidSchemaFile);
          },
          /Missing 'records' array/
        );
      } finally {
        if (fs.existsSync(invalidSchemaFile)) {
          fs.unlinkSync(invalidSchemaFile);
        }
      }
    });
  });

  describe("Integration Search Pipeline (Mocked Client)", () => {
    it("should execute end-to-end semantic search using a mocked embedding client", async () => {
      const testPipelineFile = path.join(tempTestDir, "pipeline-store.json");

      try {
        // Create store with 2 chunks
        const store = new VectorStore();
        store.add({ chunk: chunkA, embedding: [1, 0, 0] }); // login
        store.add({ chunk: chunkB, embedding: [0, 1, 0] }); // add
        await store.saveToFile(testPipelineFile);

        // Mock client returns [1, 0, 0] for query "authentication login"
        const mockClient: EmbeddingClient = {
          embedTexts: async (inputs: string[]) => {
            return inputs.map(() => [1, 0, 0]);
          },
        };

        const results = await searchCode("authentication login", 2, testPipelineFile, {
          client: mockClient,
        });

        assert.equal(results.length, 2);
        assert.equal(results[0]?.chunk.symbol, "login");
        assert.ok(Math.abs(results[0]!.score - 1.0) < 1e-4);
      } finally {
        if (fs.existsSync(testPipelineFile)) {
          fs.unlinkSync(testPipelineFile);
        }
        if (fs.existsSync(tempTestDir)) {
          fs.rmdirSync(tempTestDir);
        }
      }
    });
  });
});
