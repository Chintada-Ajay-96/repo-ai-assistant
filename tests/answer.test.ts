import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type CodeChunk } from "../src/codeChunks.js";
import { type EmbeddingClient } from "../src/embeddings.js";
import { VectorStore } from "../src/vectorStore.js";
import { type LLMClient } from "../src/llm.js";
import {
  retrieveAndAnswer,
  buildRagPrompt,
  type AnswerResult,
} from "../src/answer.js";

describe("answer - Complete RAG Answer Generation (Phase 3B)", () => {
  const chunkAuth: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "AuthService",
    type: "class",
    startLine: 9,
    endLine: 13,
    code: "class AuthService {\n  login(user) {\n    return generateToken(user);\n  }\n}",
  };

  const chunkToken: CodeChunk = {
    file: "auth.js",
    language: "javascript",
    symbol: "generateToken",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function generateToken(user) {\n  return jwt.sign({ id: user.id }, SECRET);\n}",
  };

  const chunkMath: CodeChunk = {
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
      embeddings: {
        async create(params: { model: string; input: string[] }) {
          return {
            data: params.input.map((_, i) => ({
              embedding: vector,
              index: i,
            })),
          };
        },
      },
    };
  }

  function setupTestStore(): VectorStore {
    const store = new VectorStore();
    // chunkAuth: [1, 0, 0] -> cosine sim with [1, 0, 0] is 1.0
    store.add({ chunk: chunkAuth, embedding: [1, 0, 0] });
    // chunkToken: [0.8, 0.6, 0] -> cosine sim with [1, 0, 0] is 0.8
    store.add({ chunk: chunkToken, embedding: [0.8, 0.6, 0] });
    // chunkMath: [0, 1, 0] -> cosine sim with [1, 0, 0] is 0.0
    store.add({ chunk: chunkMath, embedding: [0, 1, 0] });
    return store;
  }

  describe("buildRagPrompt", () => {
    it("should format prompt with repository context, user question, and grounding instructions", () => {
      const prompt = buildRagPrompt({
        context: "File: auth.js\nclass AuthService {}",
        question: "Where is auth handled?",
      });

      assert.ok(prompt.includes("Repository Context:"));
      assert.ok(prompt.includes("File: auth.js\nclass AuthService {}"));
      assert.ok(prompt.includes("User Question:"));
      assert.ok(prompt.includes("Where is auth handled?"));
      assert.ok(prompt.includes("Instructions:"));
      assert.ok(prompt.includes("The supplied repository context is the primary source of truth."));
      assert.ok(prompt.includes("Answer:"));
    });
  });

  describe("retrieveAndAnswer", () => {
    it("should perform successful end-to-end RAG answer generation", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      let capturedPrompt = "";

      const mockLLM: LLMClient = {
        async generateText(prompt: string) {
          capturedPrompt = prompt;
          return "Authentication is handled in AuthService in auth.js using generateToken().";
        },
      };

      const result: AnswerResult = await retrieveAndAnswer(
        "Where is authentication handled?",
        {
          llmClient: mockLLM,
          retrieveOptions: {
            store,
            client: mockEmbeddingClient,
            topK: 2,
          },
        }
      );

      // Verify answer and metadata
      assert.equal(
        result.answer,
        "Authentication is handled in AuthService in auth.js using generateToken()."
      );
      assert.equal(result.retrievedChunks, 2);
      assert.ok(result.contextCharacters > 0);
      assert.equal(result.question, "Where is authentication handled?");

      // Verify prompt contains question
      assert.ok(capturedPrompt.includes("User Question:\nWhere is authentication handled?"));

      // Verify prompt contains retrieved repository context
      assert.ok(capturedPrompt.includes("File: auth.js"));
      assert.ok(capturedPrompt.includes("Symbol: AuthService"));
      assert.ok(capturedPrompt.includes("Symbol: generateToken"));
      assert.ok(capturedPrompt.includes("class AuthService"));

      // Verify grounding instructions
      assert.ok(capturedPrompt.includes("primary source of truth"));
      assert.ok(capturedPrompt.includes("must not invent files"));
      assert.ok(capturedPrompt.includes("insufficient to answer confidently"));
    });

    it("should reject empty or whitespace questions with a clear error", async () => {
      const store = setupTestStore();
      const mockLLM: LLMClient = {
        async generateText() {
          return "test";
        },
      };

      await assert.rejects(
        async () => retrieveAndAnswer("", { llmClient: mockLLM, retrieveOptions: { store } }),
        /Question cannot be empty\./
      );

      await assert.rejects(
        async () => retrieveAndAnswer("   \n\t  ", { llmClient: mockLLM, retrieveOptions: { store } }),
        /Question cannot be empty\./
      );
    });

    it("should handle empty retrieval safely without calling LLM or hallucinating evidence", async () => {
      const emptyStore = new VectorStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      let llmWasCalled = false;

      const mockLLM: LLMClient = {
        async generateText() {
          llmWasCalled = true;
          return "Should not be called";
        },
      };

      const result = await retrieveAndAnswer("What does foo() do?", {
        llmClient: mockLLM,
        retrieveOptions: {
          store: emptyStore,
          client: mockEmbeddingClient,
        },
      });

      assert.equal(llmWasCalled, false);
      assert.equal(result.retrievedChunks, 0);
      assert.equal(result.contextCharacters, 0);
      assert.ok(
        result.answer.includes("No relevant repository context was found")
      );
      assert.ok(result.answer.includes("What does foo() do?"));
    });

    it("should propagate retrieval errors clearly", async () => {
      const mockLLM: LLMClient = {
        async generateText() {
          return "ok";
        },
      };

      // Missing vector store file
      await assert.rejects(
        async () =>
          retrieveAndAnswer("question", {
            llmClient: mockLLM,
            retrieveOptions: { storePath: "nonexistent/store.json" },
          }),
        /Vector store file not found/
      );

      // Embedding client failure
      const store = setupTestStore();
      const failingEmbeddingClient: EmbeddingClient = {
        embeddings: {
          async create() {
            throw new Error("Provider rate limit reached");
          },
        },
      };

      await assert.rejects(
        async () =>
          retrieveAndAnswer("question", {
            llmClient: mockLLM,
            retrieveOptions: {
              store,
              client: failingEmbeddingClient,
            },
          }),
        /Failed to generate query embedding/
      );
    });

    it("should propagate LLM provider errors clearly", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      const failingLLM: LLMClient = {
        async generateText() {
          throw new Error("Gemini quota exceeded 429");
        },
      };

      await assert.rejects(
        async () =>
          retrieveAndAnswer("Where is login?", {
            llmClient: failingLLM,
            retrieveOptions: {
              store,
              client: mockEmbeddingClient,
            },
          }),
        /Gemini quota exceeded 429/
      );
    });

    it("should support dependency injection for LLM client", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      class CustomTestLLM implements LLMClient {
        async generateText() {
          return "Custom injected LLM response.";
        }
      }

      const result = await retrieveAndAnswer("Where is login?", {
        llmClient: new CustomTestLLM(),
        retrieveOptions: {
          store,
          client: mockEmbeddingClient,
        },
      });

      assert.equal(result.answer, "Custom injected LLM response.");
    });

    it("should reject when llmClient is not provided", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () =>
          retrieveAndAnswer("Where is login?", {
            retrieveOptions: {
              store,
              client: mockEmbeddingClient,
            },
          } as any),
        /An LLMClient must be provided via options\.llmClient\./
      );
    });

    it("should preserve ranking order in the prompt context", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      let capturedPrompt = "";

      const mockLLM: LLMClient = {
        async generateText(prompt: string) {
          capturedPrompt = prompt;
          return "answer";
        },
      };

      await retrieveAndAnswer("auth", {
        llmClient: mockLLM,
        retrieveOptions: {
          store,
          client: mockEmbeddingClient,
          topK: 3,
        },
      });

      // chunkAuth has similarity 1.0, chunkToken has 0.8, chunkMath has 0.0
      const posAuth = capturedPrompt.indexOf("Symbol: AuthService");
      const posToken = capturedPrompt.indexOf("Symbol: generateToken");
      const posMath = capturedPrompt.indexOf("Symbol: add");

      assert.ok(posAuth !== -1);
      assert.ok(posToken !== -1);
      assert.ok(posMath !== -1);
      assert.ok(posAuth < posToken);
      assert.ok(posToken < posMath);
    });

    it("should not call LLM with unrelated fabricated context when context budget excludes chunks", async () => {
      const store = setupTestStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      let capturedPrompt = "";

      const mockLLM: LLMClient = {
        async generateText(prompt: string) {
          capturedPrompt = prompt;
          return "answer";
        },
      };

      // Very small context budget: only chunkAuth fits
      await retrieveAndAnswer("auth", {
        llmClient: mockLLM,
        retrieveOptions: {
          store,
          client: mockEmbeddingClient,
        },
        contextOptions: {
          maxCharacters: 250,
        },
      });

      assert.ok(capturedPrompt.includes("Symbol: AuthService"));
      // Lower-ranked chunks excluded by budget should NOT be present in prompt
      assert.equal(capturedPrompt.includes("Symbol: generateToken"), false);
      assert.equal(capturedPrompt.includes("Symbol: add"), false);
    });
  });
});
