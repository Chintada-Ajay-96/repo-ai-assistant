import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { type CodeChunk } from "../src/codeChunks.js";
import { type EmbeddingClient } from "../src/embeddings.js";
import { VectorStore } from "../src/vectorStore.js";
import {
  analyzeChangeTarget,
  safeAnalyzeChangeTarget,
  formatChangeContext,
  AmbiguousTargetError,
  EmptyRetrievalError,
  NoMatchingTargetError,
  StaleIndexError,
  TargetFileNotFoundError,
  FileReadError,
  ChangeAnalysisError,
  DEFAULT_AMBIGUITY_THRESHOLD,
  type TargetCodeChunk,
} from "../src/changeAnalysis.js";

describe("changeAnalysis - Change Analysis & Target Retrieval (Phase 4A)", () => {
  const chunkAuthService: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "AuthService",
    type: "class",
    startLine: 9,
    endLine: 13,
    code: "class AuthService {\n  login(user) {\n    return generateToken(user);\n  }\n}",
  };

  const chunkLoginMethod: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "login",
    type: "method",
    parent: "AuthService",
    startLine: 10,
    endLine: 12,
    code: "  login(user) {\n    return generateToken(user);\n  }",
  };

  const chunkGenerateToken: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "generateToken",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function generateToken(user) {\n  return jwt.sign({ id: user.id }, SECRET);\n}",
  };

  const chunkVerifyToken: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "verifyToken",
    type: "function",
    startLine: 5,
    endLine: 7,
    code: "function verifyToken(token) {\n  return jwt.verify(token, SECRET);\n}",
  };

  const chunkOAuthLogin: CodeChunk = {
    file: "sample-repo/oauth.js",
    language: "javascript",
    symbol: "login",
    type: "function",
    startLine: 1,
    endLine: 3,
    code: "function login(provider) {\n  return provider.authenticate();\n}",
  };

  const chunkAdd: CodeChunk = {
    file: "sample-repo/math.js",
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
    // Query vector will be [1, 0, 0]
    // Distinct vector setup:
    // verifyToken: [1, 0, 0] -> cosine sim: 1.0
    store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
    // generateToken: [0.7, 0.7141, 0] -> cosine sim: 0.7
    store.add({ chunk: chunkGenerateToken, embedding: [0.7, 0.7141, 0] });
    // authService: [0.5, 0.866, 0] -> cosine sim: 0.5
    store.add({ chunk: chunkAuthService, embedding: [0.5, 0.866, 0] });
    return store;
  }

  describe("Target Identification & Retrieval", () => {
    it("should successfully retrieve, identify, and verify a target code chunk using real disk file", async () => {
      const store = setupTestStore();
      const client = createMockEmbeddingClient([1, 0, 0]);

      const context = await analyzeChangeTarget("Add null check to verifyToken", {
        retrieveOptions: { store, client },
      });

      assert.equal(context.instruction, "Add null check to verifyToken");
      assert.equal(context.target.symbol, "verifyToken");
      assert.equal(context.target.file, "sample-repo/auth.js");
      assert.equal(context.target.startLine, 5);
      assert.equal(context.target.endLine, 7);
      assert.equal(context.target.language, "javascript");
      assert.equal(context.target.type, "function");
      assert.ok(context.target.score > 0.99);
      assert.ok(context.target.currentCode.includes("jwt.verify(token, SECRET)"));

      // References should contain remaining chunks and exclude verifyToken
      assert.equal(context.references.length, 2);
      assert.ok(context.references.every((r) => r.chunk.symbol !== "verifyToken"));
      assert.ok(context.references.some((r) => r.chunk.symbol === "generateToken"));
    });

    it("should verify code chunk using a custom readFileFn", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkAdd, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      const virtualFileContent = "function add(a, b) {\n  return a + b;\n}\n";

      const context = await analyzeChangeTarget("Refactor addition", {
        retrieveOptions: { store, client },
        readFileFn: (filePath) => {
          if (filePath === "sample-repo/math.js") {
            return virtualFileContent;
          }
          throw new Error(`File not found: ${filePath}`);
        },
      });

      assert.equal(context.target.symbol, "add");
      assert.equal(context.target.currentCode, "function add(a, b) {\n  return a + b;\n}");
    });

    it("should disambiguate using targetSymbol hint", async () => {
      const store = new VectorStore();
      // Both chunks have identical scores
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      store.add({ chunk: chunkGenerateToken, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      const context = await analyzeChangeTarget("Update token handling", {
        retrieveOptions: { store, client },
        targetSymbol: "generateToken",
      });

      assert.equal(context.target.symbol, "generateToken");
      assert.equal(context.target.startLine, 1);
      assert.equal(context.target.endLine, 3);
    });

    it("should disambiguate using targetFile hint", async () => {
      const store = new VectorStore();
      // chunkVerifyToken in auth.js vs chunkAdd in math.js with identical score
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      store.add({ chunk: chunkAdd, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      const context = await analyzeChangeTarget("Update function", {
        retrieveOptions: { store, client },
        targetFile: "auth.js",
      });

      assert.equal(context.target.file, "sample-repo/auth.js");
      assert.equal(context.target.symbol, "verifyToken");
    });

    it("should disambiguate using structured hints object with both file and symbol", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkLoginMethod, embedding: [1, 0, 0] });
      store.add({ chunk: chunkOAuthLogin, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      const context = await analyzeChangeTarget("Update login", {
        retrieveOptions: { store, client },
        hints: {
          file: "sample-repo/auth.js",
          symbol: "login",
        },
      });

      assert.equal(context.target.symbol, "login");
      assert.equal(context.target.file, "sample-repo/auth.js");
      assert.equal(context.target.parent, "AuthService");
    });
  });

  describe("Ambiguity Detection & Handling", () => {
    it("should throw AmbiguousTargetError when top two candidates have scores within ambiguity threshold", async () => {
      const store = new VectorStore();
      // Very close scores: 1.0 vs 0.999
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      store.add({ chunk: chunkGenerateToken, embedding: [0.999, 0.0447, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update token handling", {
            retrieveOptions: { store, client },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AmbiguousTargetError);
          assert.equal(err.name, "AmbiguousTargetError");
          assert.ok(err.message.includes("Ambiguous change target"));
          assert.ok(err.message.includes("verifyToken"));
          assert.ok(err.message.includes("generateToken"));
          assert.equal(err.candidates.length, 2);
          return true;
        }
      );
    });

    it("should throw AmbiguousTargetError when targetSymbol matches multiple chunks in different files", async () => {
      const store = new VectorStore();
      // Both symbols are named "login"
      store.add({ chunk: chunkLoginMethod, embedding: [1, 0, 0] });
      store.add({ chunk: chunkOAuthLogin, embedding: [0.995, 0.0998, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update login", {
            retrieveOptions: { store, client },
            targetSymbol: "login",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AmbiguousTargetError);
          assert.ok(err.message.includes("sample-repo/auth.js"));
          assert.ok(err.message.includes("sample-repo/oauth.js"));
          return true;
        }
      );
    });

    it("should respect custom ambiguityThreshold", async () => {
      const store = new VectorStore();
      // Score difference is 0.015 (less than default 0.02, but greater than custom 0.01)
      // verifyToken: sim = 1.0
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      // generateToken: sim = 0.985
      store.add({ chunk: chunkGenerateToken, embedding: [0.985, 0.1725, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      // With default threshold 0.02, it should fail as ambiguous
      await assert.rejects(async () => {
        await analyzeChangeTarget("Update token", {
          retrieveOptions: { store, client },
        });
      }, AmbiguousTargetError);

      // With tighter threshold 0.01, it should succeed without ambiguity
      const context = await analyzeChangeTarget("Update token", {
        retrieveOptions: { store, client },
        ambiguityThreshold: 0.01,
      });

      assert.equal(context.target.symbol, "verifyToken");
    });

    it("should return safe failure result in safeAnalyzeChangeTarget on ambiguity", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      store.add({ chunk: chunkGenerateToken, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      const result = await safeAnalyzeChangeTarget("Update token", {
        retrieveOptions: { store, client },
      });

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.reason, "ambiguous_target");
        assert.ok(result.candidates && result.candidates.length >= 2);
        assert.ok(result.error instanceof AmbiguousTargetError);
      }
    });
  });

  describe("Hints & Filtering Edge Cases", () => {
    it("should throw NoMatchingTargetError when targetSymbol does not match any retrieved chunk", async () => {
      const store = setupTestStore();
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update nonExistentSymbol", {
            retrieveOptions: { store, client },
            targetSymbol: "nonExistentSymbol",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof NoMatchingTargetError);
          assert.ok(err.message.includes("nonExistentSymbol"));
          return true;
        }
      );
    });

    it("should throw NoMatchingTargetError when targetFile does not match any retrieved chunk", async () => {
      const store = setupTestStore();
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update code", {
            retrieveOptions: { store, client },
            targetFile: "missing-dir/missing.js",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof NoMatchingTargetError);
          assert.ok(err.message.includes("missing-dir/missing.js"));
          return true;
        }
      );
    });
  });

  describe("Empty Retrieval & Instruction Validation", () => {
    it("should throw ChangeAnalysisError when instruction is empty or whitespace", async () => {
      await assert.rejects(async () => {
        await analyzeChangeTarget("");
      }, ChangeAnalysisError);

      await assert.rejects(async () => {
        await analyzeChangeTarget("   \n\t  ");
      }, ChangeAnalysisError);
    });

    it("should throw EmptyRetrievalError when vector store has no records", async () => {
      const store = new VectorStore();
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Add null check", {
            retrieveOptions: { store, client },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof EmptyRetrievalError);
          assert.ok(err.message.includes("No relevant code chunks found"));
          return true;
        }
      );
    });

    it("should throw EmptyRetrievalError when minScore filter excludes all chunks", async () => {
      const store = setupTestStore();
      // Best score is 1.0, set minScore to 1.1
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Add null check", {
            retrieveOptions: { store, client },
            minScore: 1.1,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof EmptyRetrievalError);
          assert.ok(err.message.includes("minimum similarity score"));
          return true;
        }
      );
    });
  });

  describe("Disk Verification & Stale Index Detection", () => {
    it("should throw TargetFileNotFoundError when target file does not exist on disk", async () => {
      const store = new VectorStore();
      const missingChunk: CodeChunk = {
        file: "non-existent-file.js",
        language: "javascript",
        symbol: "missingFunc",
        type: "function",
        startLine: 1,
        endLine: 3,
        code: "function missingFunc() {}",
      };
      store.add({ chunk: missingChunk, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update missingFunc", {
            retrieveOptions: { store, client },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof TargetFileNotFoundError);
          assert.equal(err.name, "TargetFileNotFoundError");
          assert.ok(err.message.includes("non-existent-file.js"));
          return true;
        }
      );
    });

    it("should throw StaleIndexError when code on disk has changed from indexed code", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      // Provide simulated modified file content on disk
      const modifiedDiskContent = [
        "function generateToken(user) {",
        "  return jwt.sign({ id: user.id }, SECRET);",
        "}",
        "",
        "function verifyToken(token) {",
        "  // THIS LINE HAS BEEN MODIFIED ON DISK",
        "  return jwt.verify(token, DIFFERENT_SECRET);",
        "}",
      ].join("\n");

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update verifyToken", {
            retrieveOptions: { store, client },
            readFileFn: () => modifiedDiskContent,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleIndexError);
          assert.equal(err.name, "StaleIndexError");
          assert.ok(err.message.includes("Stale index detected"));
          assert.ok(err.message.includes("npm run index"));
          assert.equal(err.file, "sample-repo/auth.js");
          assert.equal(err.startLine, 5);
          assert.equal(err.endLine, 7);
          return true;
        }
      );
    });

    it("should throw StaleIndexError when line range is out of bounds on disk", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      // File on disk has only 2 lines
      const truncatedDiskContent = "const a = 1;\nconst b = 2;\n";

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update verifyToken", {
            retrieveOptions: { store, client },
            readFileFn: () => truncatedDiskContent,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleIndexError);
          assert.ok(err.message.includes("out of bounds"));
          return true;
        }
      );
    });

    it("should throw StaleIndexError when indexed line range is invalid (startLine > endLine)", async () => {
      const store = new VectorStore();
      const corruptedChunk: CodeChunk = {
        ...chunkVerifyToken,
        startLine: 10,
        endLine: 5, // invalid!
      };
      store.add({ chunk: corruptedChunk, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update verifyToken", {
            retrieveOptions: { store, client },
            readFileFn: () => "valid content\nline 2",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleIndexError);
          assert.ok(err.message.includes("Invalid line range"));
          return true;
        }
      );
    });

    it("should throw FileReadError on unexpected file read failure", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      const client = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update verifyToken", {
            retrieveOptions: { store, client },
            readFileFn: () => {
              throw new Error("EACCES: permission denied");
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof FileReadError);
          assert.ok(err.message.includes("permission denied"));
          return true;
        }
      );
    });
  });

  describe("formatChangeContext & Structure", () => {
    it("should format structured context containing instruction, target, and references", () => {
      const target: TargetCodeChunk = {
        file: "sample-repo/auth.js",
        symbol: "verifyToken",
        type: "function",
        startLine: 5,
        endLine: 7,
        currentCode: "function verifyToken(token) {\n  return jwt.verify(token, SECRET);\n}",
        language: "javascript",
        score: 0.9412,
      };

      const references = [
        {
          chunk: chunkGenerateToken,
          score: 0.8123,
        },
      ];

      const formatted = formatChangeContext("Add token check", target, references);

      assert.ok(formatted.includes("CHANGE INSTRUCTION"));
      assert.ok(formatted.includes("Add token check"));
      assert.ok(formatted.includes("TARGET TO MODIFY"));
      assert.ok(formatted.includes("File: sample-repo/auth.js"));
      assert.ok(formatted.includes("Symbol: verifyToken"));
      assert.ok(formatted.includes("Type: function"));
      assert.ok(formatted.includes("Lines: 5-7"));
      assert.ok(formatted.includes("Language: javascript"));
      assert.ok(formatted.includes("Similarity: 0.9412"));
      assert.ok(formatted.includes("Current Code:"));
      assert.ok(formatted.includes("jwt.verify(token, SECRET)"));
      assert.ok(formatted.includes("REFERENCE CONTEXT"));
      assert.ok(formatted.includes("Symbol: generateToken"));
    });

    it("should format context cleanly when there are no reference chunks", () => {
      const target: TargetCodeChunk = {
        file: "sample-repo/auth.js",
        symbol: "verifyToken",
        type: "function",
        startLine: 5,
        endLine: 7,
        currentCode: "function verifyToken(token) {}",
        language: "javascript",
        score: 0.95,
      };

      const formatted = formatChangeContext("Check token", target, []);
      assert.ok(!formatted.includes("REFERENCE CONTEXT"));
      assert.ok(formatted.includes("TARGET TO MODIFY"));
    });
  });

  describe("Read-Only Guarantee", () => {
    it("should guarantee that repository files on disk remain completely unmodified", async () => {
      const authPath = "sample-repo/auth.js";
      const beforeContent = fs.readFileSync(authPath, "utf8");
      const beforeStat = fs.statSync(authPath);

      const store = setupTestStore();
      const client = createMockEmbeddingClient([1, 0, 0]);

      const context = await analyzeChangeTarget("Add input validation to verifyToken", {
        retrieveOptions: { store, client },
      });

      assert.ok(context);

      const afterContent = fs.readFileSync(authPath, "utf8");
      const afterStat = fs.statSync(authPath);

      assert.equal(beforeContent, afterContent, "File content on disk must not change");
      assert.equal(beforeStat.size, afterStat.size, "File size on disk must not change");
    });
  });
});
