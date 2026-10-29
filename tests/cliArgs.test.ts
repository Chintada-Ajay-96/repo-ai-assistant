import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, parseProposeArgs } from "../src/index.js";

describe("cliArgs - CLI Argument Parsing & Vector Backend Selection", () => {
  describe("--search Command Argument Parsing", () => {
    it("should parse standard search query with default lancedb backend", () => {
      const parsed = parseCliArgs(["--search", "Where is authentication handled?"]);
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should parse --backend json placed after query text", () => {
      const parsed = parseCliArgs([
        "--search",
        "Where is authentication handled?",
        "--backend",
        "json",
      ]);
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("json"));
    });

    it("should parse --backend json placed before query text", () => {
      const parsed = parseCliArgs([
        "--search",
        "--backend",
        "json",
        "Where is authentication handled?",
      ]);
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("json"));
    });

    it("should parse --backend lancedb placed after query text", () => {
      const parsed = parseCliArgs([
        "--search",
        "Where is authentication handled?",
        "--backend",
        "lancedb",
      ]);
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("lancedb"));
    });

    it("should parse --backend lancedb placed before query text", () => {
      const parsed = parseCliArgs([
        "--search",
        "--backend",
        "lancedb",
        "Where is authentication handled?",
      ]);
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("lancedb"));
    });

    it("should parse --backend=json syntax correctly", () => {
      const parsedAfter = parseCliArgs([
        "--search",
        "Where is authentication handled?",
        "--backend=json",
      ]);
      assert.equal(parsedAfter.query, "Where is authentication handled?");
      assert.equal(parsedAfter.backend, "json");
      assert.equal(parsedAfter.error, undefined);

      const parsedBefore = parseCliArgs([
        "--search",
        "--backend=json",
        "Where is authentication handled?",
      ]);
      assert.equal(parsedBefore.query, "Where is authentication handled?");
      assert.equal(parsedBefore.backend, "json");
      assert.equal(parsedBefore.error, undefined);
    });

    it("should parse --backend=lancedb syntax correctly", () => {
      const parsed = parseCliArgs([
        "--search",
        "Where is authentication handled?",
        "--backend=lancedb",
      ]);
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should return a clear error when --backend is missing a value at the end", () => {
      const parsed = parseCliArgs(["--search", "Where is authentication handled?", "--backend"]);
      assert.ok(parsed.error);
      assert.match(parsed.error, /Missing value for --backend flag/);
    });

    it("should return a clear error when --backend is followed by another flag", () => {
      const parsed = parseCliArgs([
        "--search",
        "--backend",
        "--verify",
        "Where is authentication handled?",
      ]);
      assert.ok(parsed.error);
      assert.match(parsed.error, /Missing value for --backend flag/);
    });

    it("should return a clear error when --backend= is empty", () => {
      const parsed = parseCliArgs(["--search", "--backend=", "Where is authentication handled?"]);
      assert.ok(parsed.error);
      assert.match(parsed.error, /Missing value for --backend flag/);
    });

    it("should return a clear error when an invalid backend name is specified", () => {
      const parsed = parseCliArgs([
        "--search",
        "Where is authentication handled?",
        "--backend",
        "pinecone",
      ]);
      assert.ok(parsed.error);
      assert.match(parsed.error, /Invalid backend 'pinecone'/);
    });

    it("should return a clear error when invalid backend is specified in equals syntax", () => {
      const parsed = parseCliArgs(["--search", "--backend=redis", "Where is auth?"]);
      assert.ok(parsed.error);
      assert.match(parsed.error, /Invalid backend 'redis'/);
    });

    it("should never strip ordinary query words matching 'json' when --backend was not specified", () => {
      const parsed = parseCliArgs(["--search", "How to parse json files in Node.js"]);
      assert.equal(parsed.query, "How to parse json files in Node.js");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should never strip ordinary query words matching 'lancedb' when --backend was not specified", () => {
      const parsed = parseCliArgs(["--search", "explain lancedb vector table structure"]);
      assert.equal(parsed.query, "explain lancedb vector table structure");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should preserve multi-token unquoted ordinary queries without --backend", () => {
      const parsed = parseCliArgs(["--search", "how", "json", "parsing", "works"]);
      assert.equal(parsed.query, "how json parsing works");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });
  });

  describe("PowerShell & npm Argument Normalization Heuristics", () => {
    it("should extract backend json passed after query when npm strips --backend", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?", "json"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("json"));
    });

    it("should extract backend json passed before query when npm strips --backend", () => {
      const parsed = parseCliArgs(
        ["--search", "json", "Where is authentication handled?"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.command, "search");
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("json"));
    });

    it("should extract backend lancedb when npm strips --backend", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?", "lancedb"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("lancedb"));
    });

    it("should parse backend from npm_config_backend value when passed with equals", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?"],
        { npm_config_backend: "json" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.query, "Where is authentication handled?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
    });

    it("should detect missing backend value under npm heuristic when query has whitespace", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.ok(parsed.error);
      assert.match(parsed.error, /Missing value for --backend flag/);
    });

    it("should detect invalid backend candidate under npm heuristic", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?", "pinecone"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.ok(parsed.error);
      assert.match(parsed.error, /Invalid backend 'pinecone'/);
    });

    it("should detect invalid backend set via equals in npm environment", () => {
      const parsed = parseCliArgs(
        ["--search", "Where is authentication handled?"],
        { npm_config_backend: "weaviate" } as NodeJS.ProcessEnv
      );
      assert.ok(parsed.error);
      assert.match(parsed.error, /Invalid backend 'weaviate'/);
    });
  });

  describe("--retrieve Command Argument Parsing", () => {
    it("should parse retrieval query with default lancedb backend", () => {
      const parsed = parseCliArgs(["--retrieve", "find auth middleware"]);
      assert.equal(parsed.command, "retrieve");
      assert.equal(parsed.query, "find auth middleware");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should recognize --backend json on retrieval command", () => {
      const parsed = parseCliArgs(["--retrieve", "find auth middleware", "--backend", "json"]);
      assert.equal(parsed.command, "retrieve");
      assert.equal(parsed.query, "find auth middleware");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.query.includes("json"));
    });

    it("should handle npm stripped backend flag for retrieval", () => {
      const parsed = parseCliArgs(
        ["--retrieve", "find auth middleware", "json"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.query, "find auth middleware");
      assert.equal(parsed.backend, "json");
      assert.ok(!parsed.query.includes("json"));
    });
  });

  describe("--ask Command Argument Parsing", () => {
    it("should parse ask question with default lancedb backend", () => {
      const parsed = parseCliArgs(["--ask", "How does token generation work?"]);
      assert.equal(parsed.command, "ask");
      assert.equal(parsed.question, "How does token generation work?");
      assert.equal(parsed.backend, "lancedb");
      assert.equal(parsed.error, undefined);
    });

    it("should recognize --backend json on ask command", () => {
      const parsed = parseCliArgs(["--ask", "How does token generation work?", "--backend", "json"]);
      assert.equal(parsed.command, "ask");
      assert.equal(parsed.question, "How does token generation work?");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.question.includes("json"));
    });

    it("should handle npm stripped backend flag for ask", () => {
      const parsed = parseCliArgs(
        ["--ask", "How does token generation work?", "json"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.question, "How does token generation work?");
      assert.equal(parsed.backend, "json");
      assert.ok(!parsed.question.includes("json"));
    });
  });

  describe("--propose Command Argument Parsing & Backwards Compatibility", () => {
    it("should parse instruction, file, symbol hints, and --backend flag", () => {
      const parsed = parseCliArgs([
        "--propose",
        "Add input validation",
        "--file",
        "sample-repo/auth.js",
        "--symbol",
        "verifyToken",
        "--backend",
        "json",
      ]);
      assert.equal(parsed.command, "propose");
      assert.equal(parsed.instruction, "Add input validation");
      assert.equal(parsed.targetFile, "sample-repo/auth.js");
      assert.equal(parsed.targetSymbol, "verifyToken");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
      assert.ok(!parsed.instruction.includes("json"));
      assert.ok(!parsed.instruction.includes("sample-repo"));
    });

    it("should parse --backend placed before instruction in propose", () => {
      const parsed = parseCliArgs([
        "--propose",
        "--backend",
        "json",
        "Refactor token verification",
        "--file",
        "sample-repo/auth.js",
      ]);
      assert.equal(parsed.instruction, "Refactor token verification");
      assert.equal(parsed.targetFile, "sample-repo/auth.js");
      assert.equal(parsed.backend, "json");
      assert.ok(!parsed.instruction.includes("json"));
    });

    it("should support parseProposeArgs with backwards compatibility", () => {
      const parsed = parseProposeArgs([
        "--propose",
        "Add validation check to verifyToken",
        "--backend",
        "json",
      ]);
      assert.equal(parsed.instruction, "Add validation check to verifyToken");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.targetFile, undefined);
      assert.equal(parsed.targetSymbol, undefined);
      assert.equal(parsed.error, undefined);
    });

    it("should handle npm stripped flags in propose", () => {
      const parsed = parseCliArgs(
        ["--propose", "Add validation", "sample-repo/auth.js", "verifyToken", "json"],
        {
          npm_config_file: "true",
          npm_config_symbol: "true",
          npm_config_backend: "true",
        } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.instruction, "Add validation");
      assert.equal(parsed.targetFile, "sample-repo/auth.js");
      assert.equal(parsed.targetSymbol, "verifyToken");
      assert.equal(parsed.backend, "json");
      assert.ok(!parsed.instruction.includes("json"));
      assert.ok(!parsed.instruction.includes("sample-repo"));
    });
  });

  describe("--index and --embed Argument Parsing", () => {
    it("should parse index command with targetDir and --backend", () => {
      const parsed = parseCliArgs(["--index", "custom-repo", "--backend", "json"]);
      assert.equal(parsed.command, "index");
      assert.equal(parsed.targetDir, "custom-repo");
      assert.equal(parsed.backend, "json");
      assert.equal(parsed.error, undefined);
    });

    it("should default targetDir to sample-repo when --backend is given without targetDir", () => {
      const parsed = parseCliArgs(["--index", "--backend", "json"]);
      assert.equal(parsed.command, "index");
      assert.equal(parsed.targetDir, "sample-repo");
      assert.equal(parsed.backend, "json");
    });

    it("should not treat stripped backend token as targetDir in npm run index", () => {
      const parsed = parseCliArgs(
        ["--index", "json"],
        { npm_config_backend: "true" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.targetDir, "sample-repo");
      assert.equal(parsed.backend, "json");
    });
  });

  describe("Default Backend Guarantee & Environment Variable Precedence", () => {
    it("should default to lancedb when neither CLI flag nor env var is provided", () => {
      const parsed = parseCliArgs(["--search", "authentication"], {});
      assert.equal(parsed.backend, "lancedb");
    });

    it("should respect VECTOR_STORE_BACKEND in env when CLI flag is absent", () => {
      const parsed = parseCliArgs(
        ["--search", "authentication"],
        { VECTOR_STORE_BACKEND: "json" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.backend, "json");
    });

    it("should let CLI --backend flag override VECTOR_STORE_BACKEND in env", () => {
      const parsed = parseCliArgs(
        ["--search", "authentication", "--backend", "lancedb"],
        { VECTOR_STORE_BACKEND: "json" } as NodeJS.ProcessEnv
      );
      assert.equal(parsed.backend, "lancedb");
    });
  });
});
