import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatChunkForEmbedding,
  chunkArray,
  generateEmbeddings,
  DEFAULT_EMBEDDING_MODEL,
  type EmbeddingClient,
} from "../src/embeddings.js";
import { type CodeChunk } from "../src/codeChunks.js";

describe("embeddings - Embedding Generation (Phase 2B)", () => {
  const sampleChunkWithoutParent: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "verifyToken",
    type: "function",
    startLine: 5,
    endLine: 7,
    code: "function verifyToken(token) {\n    return jwt.verify(token, SECRET);\n}",
  };

  const sampleChunkWithParent: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "login",
    type: "method",
    parent: "AuthService",
    startLine: 10,
    endLine: 12,
    code: "  login(user) {\n    return generateToken(user);\n  }",
  };

  it("1. should format CodeChunk into structured embedding text representation", () => {
    // Without parent
    const textWithoutParent = formatChunkForEmbedding(sampleChunkWithoutParent);
    const expectedWithoutParent = [
      "Language: javascript",
      "File: sample-repo/auth.js",
      "Symbol: verifyToken",
      "Type: function",
      "",
      "Code:",
      "function verifyToken(token) {\n    return jwt.verify(token, SECRET);\n}",
    ].join("\n");
    assert.equal(textWithoutParent, expectedWithoutParent);

    // With parent
    const textWithParent = formatChunkForEmbedding(sampleChunkWithParent);
    const expectedWithParent = [
      "Language: javascript",
      "File: sample-repo/auth.js",
      "Symbol: login",
      "Type: method",
      "Parent: AuthService",
      "",
      "Code:",
      "  login(user) {\n    return generateToken(user);\n  }",
    ].join("\n");
    assert.equal(textWithParent, expectedWithParent);
  });

  it("2. should successfully generate embeddings with a mocked provider", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async (params) => {
          assert.equal(params.model, DEFAULT_EMBEDDING_MODEL);
          assert.equal(params.input.length, 1);
          return {
            data: [{ embedding: fakeEmbedding, index: 0 }],
          };
        },
      },
    };

    const results = await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.embedding, fakeEmbedding);
    assert.deepEqual(results[0]?.chunk, sampleChunkWithoutParent);
  });

  it("3. should handle multiple chunks correctly", async () => {
    const chunks: CodeChunk[] = [sampleChunkWithoutParent, sampleChunkWithParent];
    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async (params) => ({
          data: params.input.map((_, i) => ({
            embedding: [i * 0.1, i * 0.2],
            index: i,
          })),
        }),
      },
    };

    const results = await generateEmbeddings(chunks, { client: mockClient });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.chunk.symbol, "verifyToken");
    assert.equal(results[1]?.chunk.symbol, "login");
    assert.deepEqual(results[0]?.embedding, [0, 0]);
    assert.deepEqual(results[1]?.embedding, [0.1, 0.2]);
  });

  it("4. should batch embedding requests according to batchSize", async () => {
    const chunks: CodeChunk[] = Array.from({ length: 5 }, (_, i) => ({
      file: "test.js",
      language: "javascript",
      symbol: `fn${i}`,
      type: "function",
      startLine: i * 3 + 1,
      endLine: i * 3 + 3,
      code: `function fn${i}() {}`,
    }));

    const batchCalls: number[] = [];
    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async (params) => {
          batchCalls.push(params.input.length);
          return {
            data: params.input.map((_, i) => ({
              embedding: [1, 2, 3],
              index: i,
            })),
          };
        },
      },
    };

    const results = await generateEmbeddings(chunks, { client: mockClient, batchSize: 2 });
    assert.equal(results.length, 5);
    // 5 chunks with batchSize 2 should make 3 calls with sizes [2, 2, 1]
    assert.deepEqual(batchCalls, [2, 2, 1]);
  });

  it("5. should guarantee embedding order matches input chunk order even if API returns out of order", async () => {
    const chunks: CodeChunk[] = [
      { ...sampleChunkWithoutParent, symbol: "first" },
      { ...sampleChunkWithoutParent, symbol: "second" },
      { ...sampleChunkWithoutParent, symbol: "third" },
    ];

    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async () => ({
          // Shuffled indices in response
          data: [
            { embedding: [3, 3], index: 2 },
            { embedding: [1, 1], index: 0 },
            { embedding: [2, 2], index: 1 },
          ],
        }),
      },
    };

    const results = await generateEmbeddings(chunks, { client: mockClient });
    assert.equal(results.length, 3);
    assert.equal(results[0]?.chunk.symbol, "first");
    assert.deepEqual(results[0]?.embedding, [1, 1]);

    assert.equal(results[1]?.chunk.symbol, "second");
    assert.deepEqual(results[1]?.embedding, [2, 2]);

    assert.equal(results[2]?.chunk.symbol, "third");
    assert.deepEqual(results[2]?.embedding, [3, 3]);
  });

  it("6. should fail clearly when OPENAI_API_KEY is missing", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await assert.rejects(
        async () => {
          await generateEmbeddings([sampleChunkWithoutParent]);
        },
        {
          message: "Missing OpenAI API key. Please set the OPENAI_API_KEY environment variable.",
        }
      );
    } finally {
      if (originalKey !== undefined) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("7. should return empty array for empty chunk list without requiring API key", async () => {
    // No client and no API key provided, must not throw
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const results = await generateEmbeddings([]);
      assert.deepEqual(results, []);
    } finally {
      if (originalKey !== undefined) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("8. should handle provider/API network errors gracefully with clear error message", async () => {
    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async () => {
          throw new Error("Rate limit exceeded (429)");
        },
      },
    };

    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Failed to generate embeddings from provider"));
        assert.ok(err.message.includes("Rate limit exceeded"));
        return true;
      }
    );
  });

  it("9. should handle malformed or invalid embedding responses gracefully", async () => {
    // Case A: Missing data array
    const invalidClientA: EmbeddingClient = {
      embeddings: {
        create: async () => ({} as any),
      },
    };
    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: invalidClientA });
      },
      /Invalid embedding response/
    );

    // Case B: Mismatched data length
    const invalidClientB: EmbeddingClient = {
      embeddings: {
        create: async () => ({
          data: [], // expected 1
        }),
      },
    };
    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: invalidClientB });
      },
      /expected 1 embeddings, received 0/
    );

    // Case C: Empty/invalid embedding vector
    const invalidClientC: EmbeddingClient = {
      embeddings: {
        create: async () => ({
          data: [{ embedding: [], index: 0 }],
        }),
      },
    };
    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: invalidClientC });
      },
      /Invalid embedding vector/
    );
  });

  it("10. should ensure chunk metadata and original code remain completely unchanged", async () => {
    const originalCode = sampleChunkWithoutParent.code;
    const mockClient: EmbeddingClient = {
      embeddings: {
        create: async () => ({
          data: [{ embedding: [0.5, 0.5], index: 0 }],
        }),
      },
    };

    const results = await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient });
    const outputChunk = results[0]!.chunk;

    assert.equal(outputChunk.code, originalCode);
    assert.deepEqual(outputChunk, sampleChunkWithoutParent);
  });

  it("should validate chunkArray helper utility", () => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkArray([1, 2], 5), [[1, 2]]);
    assert.throws(() => chunkArray([1], 0), /Batch size must be greater than 0/);
  });
});
