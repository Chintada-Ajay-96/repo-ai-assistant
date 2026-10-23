import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { type CodeChunk } from "../src/codeChunks.js";
import { type EmbeddingClient } from "../src/embeddings.js";
import { VectorStore } from "../src/vectorStore.js";
import { type LLMClient } from "../src/llm.js";
import { parseProposeArgs } from "../src/index.js";
import {
  analyzeChangeTarget,
  AmbiguousTargetError,
  StaleIndexError,
  EmptyRetrievalError,
} from "../src/changeAnalysis.js";
import {
  generateChangeFromContext,
  MalformedModelResponseError,
  EXPLANATION_START_TAG,
  EXPLANATION_END_TAG,
  PROPOSED_CODE_START_TAG,
  PROPOSED_CODE_END_TAG,
} from "../src/changeGenerator.js";
import { validateProposedChange, type ValidatedChangePlan } from "../src/changeValidation.js";

describe("proposeIntegration - End-to-End Phase 4 CLI Pipeline Integration", () => {
  const chunkVerifyToken: CodeChunk = {
    file: "sample-repo/auth.js",
    language: "javascript",
    symbol: "verifyToken",
    type: "function",
    startLine: 5,
    endLine: 7,
    code: "function verifyToken(token) {\n  return jwt.verify(token, SECRET);\n}",
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

  function createMockEmbeddingClient(vector: number[]): EmbeddingClient {
    return {
      async embedTexts(inputs: string[]) {
        return inputs.map(() => vector);
      },
    };
  }

  function createMockLLM(response: string): LLMClient {
    return {
      async generateText() {
        return response;
      },
    };
  }

  function setupAuthStore(): VectorStore {
    const store = new VectorStore();
    // Query vector: [1, 0, 0]
    // verifyToken: [1, 0, 0] -> cosine sim: 1.0
    store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
    // generateToken: [0.7, 0.7141, 0] -> cosine sim: 0.7
    store.add({ chunk: chunkGenerateToken, embedding: [0.7, 0.7141, 0] });
    return store;
  }

  describe("CLI Argument Parsing (parseProposeArgs)", () => {
    it("should correctly parse basic change instruction", () => {
      const parsed = parseProposeArgs(["--propose", "Add validation check to verifyToken"]);
      assert.equal(parsed.instruction, "Add validation check to verifyToken");
      assert.equal(parsed.targetFile, undefined);
      assert.equal(parsed.targetSymbol, undefined);
      assert.equal(parsed.error, undefined);
    });

    it("should extract --file and --symbol hints without leaking into the instruction", () => {
      const parsed = parseProposeArgs([
        "--propose",
        "Add",
        "input",
        "validation",
        "--file",
        "sample-repo/auth.js",
        "--symbol",
        "verifyToken",
      ]);

      assert.equal(parsed.instruction, "Add input validation");
      assert.equal(parsed.targetFile, "sample-repo/auth.js");
      assert.equal(parsed.targetSymbol, "verifyToken");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.instruction.includes("sample-repo/auth.js"));
      assert.ok(!parsed.instruction.includes("verifyToken"));
    });

    it("should correctly handle flags placed before the instruction", () => {
      const parsed = parseProposeArgs([
        "--propose",
        "--file",
        "sample-repo/auth.js",
        "--symbol",
        "verifyToken",
        "Refactor",
        "token",
        "verification",
      ]);

      assert.equal(parsed.instruction, "Refactor token verification");
      assert.equal(parsed.targetFile, "sample-repo/auth.js");
      assert.equal(parsed.targetSymbol, "verifyToken");
      assert.equal(parsed.error, undefined);
    });

    it("should return a clear error when --file flag is missing its value", () => {
      const parsedTrailing = parseProposeArgs(["--propose", "Add validation", "--file"]);
      assert.ok(parsedTrailing.error);
      assert.ok(parsedTrailing.error.includes("Missing value for --file flag"));

      const parsedFollowedByFlag = parseProposeArgs([
        "--propose",
        "--file",
        "--symbol",
        "verifyToken",
        "Add validation",
      ]);
      assert.ok(parsedFollowedByFlag.error);
      assert.ok(parsedFollowedByFlag.error.includes("Missing value for --file flag"));
    });

    it("should return a clear error when --symbol flag is missing its value", () => {
      const parsedTrailing = parseProposeArgs(["--propose", "Add validation", "--symbol"]);
      assert.ok(parsedTrailing.error);
      assert.ok(parsedTrailing.error.includes("Missing value for --symbol flag"));

      const parsedFollowedByFlag = parseProposeArgs([
        "--propose",
        "--symbol",
        "--file",
        "sample-repo/auth.js",
        "Add validation",
      ]);
      assert.ok(parsedFollowedByFlag.error);
      assert.ok(parsedFollowedByFlag.error.includes("Missing value for --symbol flag"));
    });

    it("should handle empty or whitespace instruction gracefully", () => {
      const parsedEmpty = parseProposeArgs(["--propose"]);
      assert.equal(parsedEmpty.instruction, "");
      assert.equal(parsedEmpty.error, undefined);
    });
  });

  describe("End-to-End Pipeline Execution (Phase 4A -> 4B -> 4C)", () => {
    it("should execute complete pipeline: retrieve target, generate replacement, and validate AST syntax", async () => {
      const store = setupAuthStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      const mockResponse = [
        EXPLANATION_START_TAG,
        "Added non-empty token validation before calling jwt.verify.",
        EXPLANATION_END_TAG,
        PROPOSED_CODE_START_TAG,
        "function verifyToken(token) {",
        '  if (!token) throw new Error("Token is required");',
        "  return jwt.verify(token, SECRET);",
        "}",
        PROPOSED_CODE_END_TAG,
      ].join("\n");

      const mockLLM = createMockLLM(mockResponse);

      // Phase 4A: Target Analysis
      const context = await analyzeChangeTarget("Add input validation to verifyToken", {
        retrieveOptions: {
          store,
          client: mockEmbeddingClient,
        },
      });

      assert.equal(context.target.symbol, "verifyToken");
      assert.equal(context.target.file, "sample-repo/auth.js");
      assert.equal(context.target.startLine, 5);
      assert.equal(context.target.endLine, 7);

      // Phase 4B: Code Change Generation
      const proposal = await generateChangeFromContext(context, {
        llmClient: mockLLM,
      });

      assert.equal(proposal.symbol, "verifyToken");
      assert.equal(proposal.file, "sample-repo/auth.js");
      assert.ok(proposal.diff.includes("+  if (!token) throw new Error(\"Token is required\");"));
      assert.equal(proposal.explanation, "Added non-empty token validation before calling jwt.verify.");

      // Phase 4C: In-Memory Validation & AST Syntax Checking
      const plan: ValidatedChangePlan = await validateProposedChange(proposal);

      assert.equal(plan.isValid, true);
      assert.equal(plan.failureReason, undefined);
      assert.equal(plan.checks.length, 5);
      assert.ok(plan.checks.every((c) => c.passed));
      assert.ok(plan.preview.includes("Status: PASSED (Ready for review)"));
      assert.ok(plan.preview.includes("[PASS] AST Syntax"));
    });

    it("should prove target repository files remain byte-for-byte unchanged after pipeline execution", async () => {
      const authPath = "sample-repo/auth.js";
      const beforeBuffer = fs.readFileSync(authPath);
      const beforeStat = fs.statSync(authPath);

      const store = setupAuthStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      const mockLLM = createMockLLM([
        EXPLANATION_START_TAG,
        "Safe change",
        EXPLANATION_END_TAG,
        PROPOSED_CODE_START_TAG,
        "function verifyToken(token) {\n  return jwt.verify(token, SECRET);\n}",
        PROPOSED_CODE_END_TAG,
      ].join("\n"));

      // Run full pipeline
      const context = await analyzeChangeTarget("Check verifyToken", {
        retrieveOptions: { store, client: mockEmbeddingClient },
      });
      const proposal = await generateChangeFromContext(context, { llmClient: mockLLM });
      const plan = await validateProposedChange(proposal);

      assert.equal(plan.isValid, true);

      // Read target file again
      const afterBuffer = fs.readFileSync(authPath);
      const afterStat = fs.statSync(authPath);

      assert.deepEqual(beforeBuffer, afterBuffer, "File bytes on disk must be strictly identical before and after");
      assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, "File modification timestamp must be strictly identical");
      assert.equal(beforeStat.size, afterStat.size, "File size must be strictly identical");
    });

    it("should catch broken AST syntax in Phase 4C and mark plan invalid while leaving disk untouched", async () => {
      const authPath = "sample-repo/auth.js";
      const beforeBuffer = fs.readFileSync(authPath);

      const store = setupAuthStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      // Mock LLM returns syntactically broken code
      const brokenLLM = createMockLLM([
        EXPLANATION_START_TAG,
        "Introduced invalid syntax",
        EXPLANATION_END_TAG,
        PROPOSED_CODE_START_TAG,
        "function verifyToken(token { return broken; // missing closing paren and brace",
        PROPOSED_CODE_END_TAG,
      ].join("\n"));

      const context = await analyzeChangeTarget("Check verifyToken", {
        retrieveOptions: { store, client: mockEmbeddingClient },
      });
      const proposal = await generateChangeFromContext(context, { llmClient: brokenLLM });
      const plan = await validateProposedChange(proposal);

      assert.equal(plan.isValid, false);
      assert.ok(plan.failureReason?.includes("Syntax error") || plan.failureReason?.includes("Missing expected"));
      assert.ok(plan.preview.includes("Status: FAILED"));
      assert.ok(plan.preview.includes("[FAIL] AST Syntax"));

      // Disk file must still be completely untouched
      const afterBuffer = fs.readFileSync(authPath);
      assert.deepEqual(beforeBuffer, afterBuffer, "Target file must not be modified on validation failure");
    });

    it("should propagate AmbiguousTargetError when retrieval has competing candidates and resolve with hint", async () => {
      const store = new VectorStore();
      // Two chunks with identical score 1.0
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      store.add({ chunk: chunkGenerateToken, embedding: [1, 0, 0] });
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      // Ambiguous call without hint
      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update token function", {
            retrieveOptions: { store, client: mockEmbeddingClient },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AmbiguousTargetError);
          assert.equal(err.candidates.length, 2);
          return true;
        }
      );

      // Disambiguated call with hint
      const context = await analyzeChangeTarget("Update token function", {
        retrieveOptions: { store, client: mockEmbeddingClient },
        targetSymbol: "verifyToken",
      });

      assert.equal(context.target.symbol, "verifyToken");
    });

    it("should propagate StaleIndexError when code on disk has drifted", async () => {
      const store = new VectorStore();
      store.add({ chunk: chunkVerifyToken, embedding: [1, 0, 0] });
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Update verifyToken", {
            retrieveOptions: { store, client: mockEmbeddingClient },
            readFileFn: () => "completely different source code on disk\nline 2\n",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleIndexError);
          assert.equal(err.file, "sample-repo/auth.js");
          assert.equal(err.startLine, 5);
          assert.equal(err.endLine, 7);
          return true;
        }
      );
    });

    it("should propagate EmptyRetrievalError when store has no matching chunks", async () => {
      const emptyStore = new VectorStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);

      await assert.rejects(
        async () => {
          await analyzeChangeTarget("Any instruction", {
            retrieveOptions: { store: emptyStore, client: mockEmbeddingClient },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof EmptyRetrievalError);
          return true;
        }
      );
    });

    it("should propagate MalformedModelResponseError when LLM returns invalid delimiter format", async () => {
      const store = setupAuthStore();
      const mockEmbeddingClient = createMockEmbeddingClient([1, 0, 0]);
      const malformedLLM = createMockLLM("I cannot fulfill this request without delimiters.");

      const context = await analyzeChangeTarget("Update verifyToken", {
        retrieveOptions: { store, client: mockEmbeddingClient },
      });

      await assert.rejects(
        async () => {
          await generateChangeFromContext(context, { llmClient: malformedLLM });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedModelResponseError);
          return true;
        }
      );
    });
  });
});
