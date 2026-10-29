import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { type CodeChunk } from "../src/codeChunks.js";
import {
  LanceDbVectorStore,
  VectorStore,
  getChunkId,
  migrateJsonToLanceDb,
  getActiveVectorStore,
  hasVectorIndexAvailable,
  DEFAULT_VECTOR_STORE_PATH,
  DEFAULT_LANCEDB_DIR,
  DEFAULT_LANCEDB_TABLE,
} from "../src/vectorStore.js";
import { retrieveRelevantCode, buildContext } from "../src/retrieval.js";
import { type EmbeddingClient } from "../src/embeddings.js";

describe("lanceDbVectorStore - LanceDB Dedicated Vector Database Integration", () => {
  const tempTestDir = path.join("tests", "fixtures", ".test_lancedb_suite");
  const tempLanceDbDir = path.join(tempTestDir, "lancedb");
  const tempJsonFile = path.join(tempTestDir, "vector-store.json");

  const chunkLogin: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "login",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function login() {\n  return true;\n}",
  };

  const chunkLogout: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "logout",
    type: "method",
    parent: "AuthService",
    startLine: 5,
    endLine: 7,
    code: "logout() {\n  return false;\n}",
  };

  const chunkAdd: CodeChunk = {
    file: "math.js",
    language: "javascript",
    symbol: "add",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function add(a, b) {\n  return a + b;\n}",
  };

  function cleanupTempDirs() {
    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {
        // Ignore residual lock on Windows if any
      }
    }
  }

  describe("LanceDB Persistence and Reopening", () => {
    it("should persist vector records to LanceDB on disk and reopen table cleanly", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "test_chunks",
        });

        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        store.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        await store.save();

        assert.equal(await store.size(), 2);

        // Reopen with a new instance
        const reopened = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "test_chunks",
        });
        await reopened.load();

        assert.equal(await reopened.size(), 2);

        const idLogin = getChunkId(chunkLogin);
        const retrieved = await reopened.get(idLogin);
        assert.ok(retrieved, "Record should be retrieved from LanceDB table");
        assert.equal(retrieved.chunk.symbol, "login");
        assert.equal(retrieved.chunk.file, "auth.js");
        assert.deepEqual(retrieved.embedding, [1, 0, 0]);
      } finally {
        cleanupTempDirs();
      }
    });

    it("should throw a clear error when attempting to load a non-existent LanceDB table", async () => {
      cleanupTempDirs();
      const nonExistent = new LanceDbVectorStore({
        dbDir: path.join(tempTestDir, "non_existent"),
        tableName: "missing_table",
      });

      await assert.rejects(
        async () => {
          await nonExistent.load();
        },
        /LanceDB table 'missing_table' not found/
      );
    });
  });

  describe("Vector Insertion, Lookup, and Ranking", () => {
    it("should rank query results descending by cosine similarity score", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "ranking_chunks",
        });

        // chunkLogin: [1, 0, 0] -> cosine sim with [1, 0, 0] is 1.0
        // chunkLogout: [0.70710678, 0.70710678, 0] -> cosine sim with [1, 0, 0] is ~0.7071
        // chunkAdd: [0, 1, 0] -> cosine sim with [1, 0, 0] is 0.0
        store.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        store.add({ chunk: chunkLogout, embedding: [0.70710678, 0.70710678, 0] });
        await store.save();

        const results = await store.search([1, 0, 0], 3);
        assert.equal(results.length, 3);

        assert.equal(results[0]?.chunk.symbol, "login");
        assert.ok(Math.abs(results[0]!.score - 1.0) < 1e-4, `Expected ~1.0, got ${results[0]!.score}`);

        assert.equal(results[1]?.chunk.symbol, "logout");
        assert.ok(Math.abs(results[1]!.score - 0.7071) < 1e-3, `Expected ~0.7071, got ${results[1]!.score}`);

        assert.equal(results[2]?.chunk.symbol, "add");
        assert.ok(Math.abs(results[2]!.score - 0.0) < 1e-4, `Expected ~0.0, got ${results[2]!.score}`);
      } finally {
        cleanupTempDirs();
      }
    });

    it("should strictly respect the topK parameter ceiling", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "limit_chunks",
        });

        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        store.add({ chunk: chunkLogout, embedding: [0.8, 0.6, 0] });
        store.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        await store.save();

        const top1 = await store.search([1, 0, 0], 1);
        assert.equal(top1.length, 1);
        assert.equal(top1[0]?.chunk.symbol, "login");

        const top2 = await store.search([1, 0, 0], 2);
        assert.equal(top2.length, 2);
      } finally {
        cleanupTempDirs();
      }
    });
  });

  describe("Similarity and Distance Score Semantics", () => {
    it("should accurately convert LanceDB cosine distance to cosine similarity with boundary clamping", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "semantic_scores",
        });

        const chunkOpposite: CodeChunk = {
          file: "opposite.js",
          language: "javascript",
          symbol: "opposite",
          type: "function",
          startLine: 1,
          endLine: 2,
          code: "function opposite() {}",
        };

        // Identical: [1, 0, 0] -> LanceDB distance: 0 -> similarity: 1.0
        // Orthogonal: [0, 1, 0] -> LanceDB distance: 1 -> similarity: 0.0
        // Opposite: [-1, 0, 0] -> LanceDB distance: 2 -> similarity: -1.0
        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        store.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        store.add({ chunk: chunkOpposite, embedding: [-1, 0, 0] });
        await store.save();

        const results = await store.search([1, 0, 0], 3);
        assert.equal(results.length, 3);

        const loginRes = results.find((r) => r.chunk.symbol === "login");
        assert.ok(loginRes);
        assert.ok(Math.abs(loginRes.score - 1.0) < 1e-4);

        const addRes = results.find((r) => r.chunk.symbol === "add");
        assert.ok(addRes);
        assert.ok(Math.abs(addRes.score - 0.0) < 1e-4);

        const oppRes = results.find((r) => r.chunk.symbol === "opposite");
        assert.ok(oppRes);
        assert.ok(Math.abs(oppRes.score - (-1.0)) < 1e-4);
      } finally {
        cleanupTempDirs();
      }
    });
  });

  describe("Dimension Validation and Malformed Record Rejection", () => {
    it("should reject records with dimension mismatches during add", () => {
      const store = new LanceDbVectorStore({
        expectedDimension: 3,
      });

      store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });

      assert.throws(
        () => store.add({ chunk: chunkAdd, embedding: [1, 0] }),
        /Vector dimension mismatch: expected dimension 3, but received 2/
      );
    });

    it("should reject records with non-finite embedding numbers", () => {
      const store = new LanceDbVectorStore();
      assert.throws(
        () => store.add({ chunk: chunkLogin, embedding: [NaN, 0, 0] }),
        /Embedding vector for symbol 'login' contains non-finite numbers/
      );
    });

    it("should reject search query vectors with dimension mismatches", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "dim_check",
          expectedDimension: 3,
        });

        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        await store.save();

        await assert.rejects(
          async () => {
            await store.search([1, 0], 5);
          },
          /Vector dimension mismatch: query vector has dimension 2, but table expects dimension 3/
        );
      } finally {
        cleanupTempDirs();
      }
    });

    it("should validate topK parameter strictly", async () => {
      const store = new LanceDbVectorStore();
      await assert.rejects(async () => store.search([1, 0, 0], 0), /topK must be a positive integer/);
      await assert.rejects(async () => store.search([1, 0, 0], -1), /topK must be a positive integer/);
      await assert.rejects(async () => store.search([1, 0, 0], 1.5), /topK must be a positive integer/);
    });
  });

  describe("Retrieval Compatibility and Context Construction", () => {
    it("should integrate with retrieveRelevantCode and buildContext seamlessly", async () => {
      cleanupTempDirs();
      try {
        const store = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "retrieval_chunks",
        });

        store.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        store.add({ chunk: chunkLogout, embedding: [0.8, 0.6, 0] });
        await store.save();

        const mockClient: EmbeddingClient = {
          async embedTexts(inputs: string[]) {
            return inputs.map(() => [1, 0, 0]);
          },
        };

        const retrieval = await retrieveRelevantCode("how to authenticate", {
          store,
          client: mockClient,
          topK: 2,
        });

        assert.equal(retrieval.query, "how to authenticate");
        assert.equal(retrieval.results.length, 2);
        assert.equal(retrieval.results[0]!.chunk.symbol, "login");
        assert.ok(retrieval.results[0]!.score >= retrieval.results[1]!.score);

        const context = buildContext(retrieval.results, { maxCharacters: 12000 });
        assert.equal(context.includedChunks, 2);
        assert.ok(context.context.includes("Symbol: login"));
        assert.ok(context.context.includes("Symbol: logout"));
        assert.ok(context.context.includes("Parent: AuthService"));
        assert.ok(context.context.includes("Similarity: 1"));
      } finally {
        cleanupTempDirs();
      }
    });
  });

  describe("JSON to LanceDB Migration & Auto-Fallback", () => {
    it("should migrate existing JSON vector store records into LanceDB without re-embedding", async () => {
      cleanupTempDirs();
      try {
        fs.mkdirSync(tempTestDir, { recursive: true });

        // Create a JSON vector store with 2 records
        const jsonStore = new VectorStore();
        jsonStore.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        jsonStore.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        await jsonStore.saveToFile(tempJsonFile);

        assert.ok(fs.existsSync(tempJsonFile));

        // Migrate to LanceDB
        const migratedCount = await migrateJsonToLanceDb(tempJsonFile, tempLanceDbDir, "migrated");
        assert.equal(migratedCount, 2);

        // Open LanceDB and verify records
        const lanceStore = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName: "migrated",
        });
        await lanceStore.load();
        assert.equal(await lanceStore.size(), 2);

        const searchRes = await lanceStore.search([1, 0, 0], 1);
        assert.equal(searchRes.length, 1);
        assert.equal(searchRes[0]?.chunk.symbol, "login");
      } finally {
        cleanupTempDirs();
      }
    });

    it("should respect backend: json override via getActiveVectorStore", async () => {
      cleanupTempDirs();
      try {
        fs.mkdirSync(tempTestDir, { recursive: true });
        const jsonStore = new VectorStore();
        jsonStore.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        await jsonStore.saveToFile(tempJsonFile);

        const store = await getActiveVectorStore({
          backend: "json",
          jsonPath: tempJsonFile,
        });

        assert.ok(store instanceof VectorStore);
        assert.equal(await store.size(), 1);
      } finally {
        cleanupTempDirs();
      }
    });

    it("should report availability correctly with hasVectorIndexAvailable", () => {
      cleanupTempDirs();
      assert.equal(
        hasVectorIndexAvailable({
          jsonPath: path.join(tempTestDir, "absent.json"),
          lanceDbDir: path.join(tempTestDir, "absent_dir"),
        }),
        false
      );

      fs.mkdirSync(tempTestDir, { recursive: true });
      fs.writeFileSync(tempJsonFile, "{}");

      assert.equal(
        hasVectorIndexAvailable({
          jsonPath: tempJsonFile,
          lanceDbDir: path.join(tempTestDir, "absent_dir"),
        }),
        true
      );
      cleanupTempDirs();
    });
  });

  describe("Indexing Consistency & Stale Chunk Replacement", () => {
    it("should overwrite and completely remove stale chunks on re-indexing when source chunks are removed", async () => {
      cleanupTempDirs();
      try {
        const tableName = "stale_chunk_test";

        // Initial indexing run: 3 chunks (chunkLogin, chunkLogout, chunkAdd)
        const initialStore = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        initialStore.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        initialStore.add({ chunk: chunkLogout, embedding: [0.7071, 0.7071, 0] });
        initialStore.add({ chunk: chunkAdd, embedding: [0, 1, 0] });
        await initialStore.save();

        assert.equal(await initialStore.size(), 3);
        const idAdd = getChunkId(chunkAdd);
        assert.ok(await initialStore.get(idAdd), "chunkAdd should exist in initial index");

        // Re-indexing run: chunkAdd was removed from repository, only 2 chunks remain
        const reindexStore = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        reindexStore.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        reindexStore.add({ chunk: chunkLogout, embedding: [0.7071, 0.7071, 0] });
        await reindexStore.save();

        assert.equal(await reindexStore.size(), 2);

        // Verify reopened store from disk has no trace of stale chunkAdd
        const verifiedStore = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        await verifiedStore.load();
        assert.equal(await verifiedStore.size(), 2);

        const staleChunk = await verifiedStore.get(idAdd);
        assert.equal(staleChunk, undefined, "Stale chunkAdd should not exist after re-indexing");

        const searchResults = await verifiedStore.search([0, 1, 0], 5);
        assert.equal(searchResults.length, 2);
        assert.ok(searchResults.every((r) => r.chunk.symbol !== "add"), "Stale chunkAdd must not appear in search results");
      } finally {
        cleanupTempDirs();
      }
    });

    it("should drop table and leave no stale records when re-indexing an empty repository", async () => {
      cleanupTempDirs();
      try {
        const tableName = "empty_reindex_test";

        const storeWithData = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        storeWithData.add({ chunk: chunkLogin, embedding: [1, 0, 0] });
        await storeWithData.save();

        assert.equal(await storeWithData.size(), 1);

        // Re-index with 0 chunks (e.g. empty directory)
        const emptyStore = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        await emptyStore.save();

        assert.equal(await emptyStore.size(), 0);

        // Verify attempting to load table indicates table was dropped
        const reloaded = new LanceDbVectorStore({
          dbDir: tempLanceDbDir,
          tableName,
        });
        await assert.rejects(
          async () => {
            await reloaded.load();
          },
          /LanceDB table 'empty_reindex_test' not found/
        );
      } finally {
        cleanupTempDirs();
      }
    });
  });
});
