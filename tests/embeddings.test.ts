import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatChunkForEmbedding,
  chunkArray,
  generateEmbeddings,
  generateQueryEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_BATCH_SIZE,
  GeminiEmbeddingClient,
  type EmbeddingClient,
  type GeminiEmbeddingSdkClient,
} from "../src/embeddings.js";
import { type CodeChunk } from "../src/codeChunks.js";

describe("embeddings - Gemini Embedding Migration (Phase 2B-G)", () => {
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
      embedTexts: async (inputs: string[]) => {
        assert.equal(inputs.length, 1);
        return [fakeEmbedding];
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
      embedTexts: async (inputs: string[]) => {
        return inputs.map((_, i) => [i * 0.1, i * 0.2]);
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
      embedTexts: async (inputs: string[]) => {
        batchCalls.push(inputs.length);
        return inputs.map(() => [1, 2, 3]);
      },
    };

    const results = await generateEmbeddings(chunks, { client: mockClient, batchSize: 2 });
    assert.equal(results.length, 5);
    // 5 chunks with batchSize 2 should make 3 calls with sizes [2, 2, 1]
    assert.deepEqual(batchCalls, [2, 2, 1]);
  });

  it("5. should guarantee embedding order matches input chunk order", async () => {
    const chunks: CodeChunk[] = [
      { ...sampleChunkWithoutParent, symbol: "first" },
      { ...sampleChunkWithoutParent, symbol: "second" },
      { ...sampleChunkWithoutParent, symbol: "third" },
    ];

    const mockClient: EmbeddingClient = {
      embedTexts: async (inputs: string[]) => {
        return inputs.map((input) => {
          if (input.includes("Symbol: first")) return [1, 1];
          if (input.includes("Symbol: second")) return [2, 2];
          return [3, 3];
        });
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

  it("6. should generate query embedding matching the same embedding space", async () => {
    const expectedVector = [0.42, 0.84, 0.16];
    const mockClient: EmbeddingClient = {
      embedTexts: async (inputs: string[]) => {
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0], "Where is authentication handled?");
        return [expectedVector];
      },
    };

    const vector = await generateQueryEmbedding("Where is authentication handled?", {
      client: mockClient,
    });
    assert.deepEqual(vector, expectedVector);
  });

  it("7. should throw clear error on empty query", async () => {
    await assert.rejects(
      async () => {
        await generateQueryEmbedding("");
      },
      /Query cannot be empty/
    );

    await assert.rejects(
      async () => {
        await generateQueryEmbedding("   ");
      },
      /Query cannot be empty/
    );
  });

  it("8. should fail clearly when GEMINI_API_KEY is missing", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      await assert.rejects(
        async () => {
          await generateEmbeddings([sampleChunkWithoutParent]);
        },
        {
          message: "Missing Gemini API key. Please set the GEMINI_API_KEY environment variable.",
        }
      );

      await assert.rejects(
        async () => {
          await generateQueryEmbedding("test query");
        },
        {
          message: "Missing Gemini API key. Please set the GEMINI_API_KEY environment variable.",
        }
      );
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      }
    }
  });

  it("9. should return empty array for empty chunk list without requiring API key", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const results = await generateEmbeddings([]);
      assert.deepEqual(results, []);
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      }
    }
  });

  it("10. should handle provider/API network errors gracefully with clear error message", async () => {
    const mockClient: EmbeddingClient = {
      embedTexts: async () => {
        throw new Error("Rate limit exceeded (429)");
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

    await assert.rejects(
      async () => {
        await generateQueryEmbedding("query", { client: mockClient });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Failed to generate query embedding from provider"));
        assert.ok(err.message.includes("Rate limit exceeded"));
        return true;
      }
    );
  });

  it("11. should handle malformed responses gracefully", async () => {
    // Mismatched length from client
    const invalidClientLength: EmbeddingClient = {
      embedTexts: async () => [],
    };
    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: invalidClientLength });
      },
      /expected 1 embeddings, received 0/
    );

    // Empty vector returned
    const invalidClientVector: EmbeddingClient = {
      embedTexts: async () => [[]],
    };
    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: invalidClientVector });
      },
      /Invalid embedding vector/
    );
  });

  it("12. should reject invalid batch sizes", async () => {
    const mockClient: EmbeddingClient = {
      embedTexts: async () => [[0.1]],
    };

    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient, batchSize: 0 });
      },
      /Batch size must be greater than 0, received 0/
    );

    await assert.rejects(
      async () => {
        await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient, batchSize: -5 });
      },
      /Batch size must be greater than 0, received -5/
    );
  });

  it("13. should support dependency injection with GeminiEmbeddingClient and SDK mock", async () => {
    let requestedModel = "";
    let receivedContents: string[] = [];

    const mockSdkClient: GeminiEmbeddingSdkClient = {
      models: {
        embedContent: async (params) => {
          requestedModel = params.model;
          receivedContents = params.contents;
          return {
            embeddings: params.contents.map(() => ({
              values: [0.123, 0.456, 0.789],
            })),
          };
        },
      },
    };

    const client = new GeminiEmbeddingClient({
      sdkClient: mockSdkClient,
      model: "gemini-embedding-001",
    });

    const vectors = await client.embedTexts(["first snippet", "second snippet"]);
    assert.equal(vectors.length, 2);
    assert.deepEqual(vectors[0], [0.123, 0.456, 0.789]);
    assert.deepEqual(vectors[1], [0.123, 0.456, 0.789]);
    assert.equal(requestedModel, "gemini-embedding-001");
    assert.deepEqual(receivedContents, ["first snippet", "second snippet"]);
  });

  it("14. should validate SDK response schema in GeminiEmbeddingClient", async () => {
    // Missing embeddings array
    const malformedSdkClientA: GeminiEmbeddingSdkClient = {
      models: {
        embedContent: async () => ({} as any),
      },
    };
    const clientA = new GeminiEmbeddingClient({ sdkClient: malformedSdkClientA });
    await assert.rejects(
      async () => {
        await clientA.embedTexts(["test"]);
      },
      /missing or malformed 'embeddings' array/
    );

    // Mismatched length
    const malformedSdkClientB: GeminiEmbeddingSdkClient = {
      models: {
        embedContent: async () => ({
          embeddings: [], // expected 1
        }),
      },
    };
    const clientB = new GeminiEmbeddingClient({ sdkClient: malformedSdkClientB });
    await assert.rejects(
      async () => {
        await clientB.embedTexts(["test"]);
      },
      /expected 1 embeddings, received 0/
    );

    // Invalid embedding vector (empty values)
    const malformedSdkClientC: GeminiEmbeddingSdkClient = {
      models: {
        embedContent: async () => ({
          embeddings: [{ values: [] }],
        }),
      },
    };
    const clientC = new GeminiEmbeddingClient({ sdkClient: malformedSdkClientC });
    await assert.rejects(
      async () => {
        await clientC.embedTexts(["test"]);
      },
      /Invalid embedding vector at index 0/
    );
  });

  it("15. should support custom model configuration", async () => {
    let capturedModel = "";
    const mockSdkClient: GeminiEmbeddingSdkClient = {
      models: {
        embedContent: async (params) => {
          capturedModel = params.model;
          return {
            embeddings: [{ values: [0.1] }],
          };
        },
      },
    };

    // Default model
    const defaultClient = new GeminiEmbeddingClient({ sdkClient: mockSdkClient });
    assert.equal(defaultClient.getModel(), DEFAULT_EMBEDDING_MODEL);
    assert.equal(DEFAULT_EMBEDDING_MODEL, "gemini-embedding-001");

    // Custom model
    const customClient = new GeminiEmbeddingClient({
      sdkClient: mockSdkClient,
      model: "custom-gemini-embedding",
    });
    assert.equal(customClient.getModel(), "custom-gemini-embedding");

    await customClient.embedTexts(["hello"]);
    assert.equal(capturedModel, "custom-gemini-embedding");
  });

  it("16. should ensure chunk metadata and original code remain completely unchanged", async () => {
    const originalCode = sampleChunkWithoutParent.code;
    const mockClient: EmbeddingClient = {
      embedTexts: async () => [[0.5, 0.5]],
    };

    const results = await generateEmbeddings([sampleChunkWithoutParent], { client: mockClient });
    const outputChunk = results[0]!.chunk;

    assert.equal(outputChunk.code, originalCode);
    assert.deepEqual(outputChunk, sampleChunkWithoutParent);
  });

  it("17. should validate chunkArray helper utility", () => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkArray([1, 2], 5), [[1, 2]]);
    assert.throws(() => chunkArray([1], 0), /Batch size must be greater than 0/);
    assert.equal(DEFAULT_BATCH_SIZE, 20);
  });
});
