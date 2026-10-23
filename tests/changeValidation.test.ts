import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { type ProposedChange } from "../src/changeGenerator.js";
import {
  validateProposedChange,
  simulateReplacement,
  formatDryRunPreview,
  SYNTAX_VALIDATION_DISCLAIMER,
  type ValidatedChangePlan,
} from "../src/changeValidation.js";

describe("changeValidation - Validation of Proposed Code Changes (Phase 4C)", () => {
  const validJsAuthOriginal = "function verifyToken(token) {\n  return jwt.verify(token, SECRET);\n}";
  const validJsAuthProposed = [
    "function verifyToken(token) {",
    '  if (!token) throw new Error("Token is required");',
    "  return jwt.verify(token, SECRET);",
    "}",
  ].join("\n");

  const validJsProposal: ProposedChange = {
    file: "sample-repo/auth.js",
    targetFile: "sample-repo/auth.js",
    symbol: "verifyToken",
    targetSymbol: "verifyToken",
    startLine: 5,
    endLine: 7,
    originalCode: validJsAuthOriginal,
    proposedCode: validJsAuthProposed,
    diff: [
      "--- sample-repo/auth.js (original)",
      "+++ sample-repo/auth.js (proposed)",
      "@@ -5,3 +5,4 @@",
      " function verifyToken(token) {",
      '+  if (!token) throw new Error("Token is required");',
      "   return jwt.verify(token, SECRET);",
      " }",
    ].join("\n"),
    explanation: "Add token check before verification.",
  };

  describe("simulateReplacement", () => {
    const sampleSource = [
      "// Line 1: Header",
      "const SECRET = 'xyz';",
      "function oldFunc() {",
      "  return 1;",
      "}",
      "// Line 6: Footer",
    ].join("\n");

    it("should correctly replace target lines and preserve all preceding and succeeding lines", () => {
      const replacement = "function newFunc() {\n  return 2;\n}";
      const result = simulateReplacement(sampleSource, 3, 5, replacement);

      const lines = result.simulatedContent.split("\n");

      // Before lines
      assert.equal(lines[0], "// Line 1: Header");
      assert.equal(lines[1], "const SECRET = 'xyz';");

      // Replaced lines
      assert.equal(lines[2], "function newFunc() {");
      assert.equal(lines[3], "  return 2;");
      assert.equal(lines[4], "}");

      // After lines
      assert.equal(lines[5], "// Line 6: Footer");
      assert.equal(lines.length, 6);

      assert.deepEqual(result.beforeLines, ["// Line 1: Header", "const SECRET = 'xyz';"]);
      assert.deepEqual(result.afterLines, ["// Line 6: Footer"]);
    });

    it("should handle replacements at the beginning of the file (startLine = 1)", () => {
      const replacement = "// Brand new header\nconst SECRET = 'abc';";
      const result = simulateReplacement(sampleSource, 1, 2, replacement);

      const lines = result.simulatedContent.split("\n");
      assert.equal(lines[0], "// Brand new header");
      assert.equal(lines[1], "const SECRET = 'abc';");
      assert.equal(lines[2], "function oldFunc() {");
      assert.deepEqual(result.beforeLines, []);
    });

    it("should handle replacements at the very end of the file", () => {
      const replacement = "// Replacement footer line";
      const result = simulateReplacement(sampleSource, 6, 6, replacement);

      const lines = result.simulatedContent.split("\n");
      assert.equal(lines[5], "// Replacement footer line");
      assert.deepEqual(result.afterLines, []);
    });

    it("should handle replacements that expand the line count", () => {
      const expansion = "function oldFunc() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}";
      const result = simulateReplacement(sampleSource, 3, 5, expansion);

      const lines = result.simulatedContent.split("\n");
      assert.equal(lines.length, 8);
      assert.equal(lines[lines.length - 1], "// Line 6: Footer");
    });

    it("should handle replacements that contract the line count", () => {
      const contraction = "const oldFunc = () => 1;";
      const result = simulateReplacement(sampleSource, 3, 5, contraction);

      const lines = result.simulatedContent.split("\n");
      assert.equal(lines.length, 4);
      assert.equal(lines[2], "const oldFunc = () => 1;");
      assert.equal(lines[3], "// Line 6: Footer");
    });
  });

  describe("JavaScript Validation", () => {
    it("should pass validation for a valid JavaScript replacement on real disk fixture", async () => {
      const plan: ValidatedChangePlan = await validateProposedChange(validJsProposal);

      assert.equal(plan.isValid, true);
      assert.equal(plan.failureReason, undefined);
      assert.equal(plan.proposal.symbol, "verifyToken");
      assert.equal(plan.checks.length, 5);

      for (const check of plan.checks) {
        assert.equal(check.passed, true, `Check '${check.name}' should have passed.`);
      }

      assert.ok(plan.preview.includes("[PASS] File Existence"));
      assert.ok(plan.preview.includes("[PASS] Line Boundaries"));
      assert.ok(plan.preview.includes("[PASS] Source Freshness"));
      assert.ok(plan.preview.includes("[PASS] Grammar Support"));
      assert.ok(plan.preview.includes("[PASS] AST Syntax"));
      assert.ok(plan.preview.includes("Status: PASSED (Ready for review)"));
      assert.ok(plan.preview.includes(SYNTAX_VALIDATION_DISCLAIMER));
    });

    it("should fail validation when proposed JavaScript code introduces syntax errors", async () => {
      const brokenJsProposal: ProposedChange = {
        ...validJsProposal,
        proposedCode: "function verifyToken(token { return broken; // missing closing paren and brace",
      };

      const plan: ValidatedChangePlan = await validateProposedChange(brokenJsProposal);

      assert.equal(plan.isValid, false);
      assert.ok(plan.failureReason);
      assert.ok(plan.failureReason.includes("Syntax error") || plan.failureReason.includes("Missing expected"));

      const syntaxCheck = plan.checks.find((c) => c.id === "syntax_valid");
      assert.ok(syntaxCheck);
      assert.equal(syntaxCheck.passed, false);

      assert.ok(plan.preview.includes("Status: FAILED"));
      assert.ok(plan.preview.includes("[FAIL] AST Syntax"));
      assert.ok(plan.preview.includes("FAILURE DETAILS:"));
    });
  });

  describe("TypeScript Validation", () => {
    const tsFileContent = [
      "export interface UserConfig {",
      "  apiKey: string;",
      "  timeout?: number;",
      "}",
      "",
      "export function getConfig(): UserConfig {",
      "  return { apiKey: 'default' };",
      "}",
    ].join("\n");

    const validTsProposal: ProposedChange = {
      file: "src/config.ts",
      targetFile: "src/config.ts",
      symbol: "getConfig",
      targetSymbol: "getConfig",
      startLine: 6,
      endLine: 8,
      originalCode: "export function getConfig(): UserConfig {\n  return { apiKey: 'default' };\n}",
      proposedCode: [
        "export function getConfig(overrideKey?: string): UserConfig {",
        "  return { apiKey: overrideKey ?? 'default', timeout: 5000 };",
        "}",
      ].join("\n"),
      diff: "diff placeholder",
      explanation: "Add optional overrideKey parameter and default timeout.",
    };

    it("should pass validation for a valid TypeScript replacement", async () => {
      const plan = await validateProposedChange(validTsProposal, {
        readFileFn: () => tsFileContent,
      });

      assert.equal(plan.isValid, true);
      const syntaxCheck = plan.checks.find((c) => c.id === "syntax_valid");
      assert.ok(syntaxCheck);
      assert.equal(syntaxCheck.passed, true);

      const grammarCheck = plan.checks.find((c) => c.id === "language_supported");
      assert.ok(grammarCheck);
      assert.equal(grammarCheck.passed, true);
      assert.ok(grammarCheck.message.includes("typescript"));
    });

    it("should fail validation for a broken TypeScript replacement", async () => {
      const brokenTsProposal: ProposedChange = {
        ...validTsProposal,
        proposedCode: "export function getConfig(overrideKey: : string { return 42; }",
      };

      const plan = await validateProposedChange(brokenTsProposal, {
        readFileFn: () => tsFileContent,
      });

      assert.equal(plan.isValid, false);
      const syntaxCheck = plan.checks.find((c) => c.id === "syntax_valid");
      assert.ok(syntaxCheck);
      assert.equal(syntaxCheck.passed, false);
      assert.ok(plan.preview.includes("[FAIL] AST Syntax"));
    });
  });

  describe("Error Conditions & Edge Cases", () => {
    it("should fail validation when target file does not exist", async () => {
      const missingFileProposal: ProposedChange = {
        ...validJsProposal,
        file: "non-existent-directory/non-existent-file.js",
      };

      const plan = await validateProposedChange(missingFileProposal);

      assert.equal(plan.isValid, false);
      const fileCheck = plan.checks.find((c) => c.id === "file_exists");
      assert.ok(fileCheck);
      assert.equal(fileCheck.passed, false);
      assert.ok(plan.failureReason?.includes("Target file not found"));
    });

    it("should fail validation when line range is invalid (out of bounds or start > end)", async () => {
      const fileContent = "const a = 1;\nconst b = 2;\n";

      // Case 1: startLine > endLine
      const invertedRangeProposal: ProposedChange = {
        ...validJsProposal,
        startLine: 5,
        endLine: 2,
      };

      const plan1 = await validateProposedChange(invertedRangeProposal, {
        readFileFn: () => fileContent,
      });

      assert.equal(plan1.isValid, false);
      const rangeCheck1 = plan1.checks.find((c) => c.id === "line_range_valid");
      assert.ok(rangeCheck1);
      assert.equal(rangeCheck1.passed, false);

      // Case 2: startLine exceeds file line count
      const outOfBoundsProposal: ProposedChange = {
        ...validJsProposal,
        startLine: 10,
        endLine: 12,
      };

      const plan2 = await validateProposedChange(outOfBoundsProposal, {
        readFileFn: () => fileContent,
      });

      assert.equal(plan2.isValid, false);
      const rangeCheck2 = plan2.checks.find((c) => c.id === "line_range_valid");
      assert.ok(rangeCheck2);
      assert.equal(rangeCheck2.passed, false);
    });

    it("should fail safely with stale-target message when original code does not match disk", async () => {
      const modifiedDiskContent = [
        "function generateToken(user) {",
        "  return jwt.sign({ id: user.id }, SECRET);",
        "}",
        "",
        "function verifyToken(token) {",
        "  // SOMEONE ELSE EDITED THIS FILE ON DISK",
        "  return jwt.verify(token, ANOTHER_KEY);",
        "}",
      ].join("\n");

      const plan = await validateProposedChange(validJsProposal, {
        readFileFn: () => modifiedDiskContent,
      });

      assert.equal(plan.isValid, false);
      const freshnessCheck = plan.checks.find((c) => c.id === "source_match");
      assert.ok(freshnessCheck);
      assert.equal(freshnessCheck.passed, false);
      assert.ok(plan.failureReason?.includes("Target source in 'sample-repo/auth.js' has changed"));
      assert.ok(plan.preview.includes("[FAIL] Source Freshness"));
    });

    it("should fail validation when target file has an unsupported extension", async () => {
      const yamlContent = "key: value\nfoo: bar";
      const unsupportedProposal: ProposedChange = {
        ...validJsProposal,
        file: "config.yaml",
        targetFile: "config.yaml",
        startLine: 1,
        endLine: 2,
        originalCode: yamlContent,
      };

      const plan = await validateProposedChange(unsupportedProposal, {
        readFileFn: () => yamlContent,
      });

      assert.equal(plan.isValid, false);
      const grammarCheck = plan.checks.find((c) => c.id === "language_supported");
      assert.ok(grammarCheck);
      assert.equal(grammarCheck.passed, false);
      assert.ok(grammarCheck.message.includes("Unsupported language grammar"));
    });
  });

  describe("Syntax Notice & Semantic Disclaimer", () => {
    it("should clearly state that syntax validation does not guarantee runtime or semantic correctness", async () => {
      const plan = await validateProposedChange(validJsProposal);

      assert.equal(plan.syntaxNotice, SYNTAX_VALIDATION_DISCLAIMER);
      assert.ok(plan.preview.includes("NOTICE:"));
      assert.ok(plan.preview.includes("Syntax validation confirms grammatical validity with Tree-sitter AST, but does not guarantee semantic correctness"));
    });
  });

  describe("Strict Read-Only Verification", () => {
    it("should ensure repository files on disk remain byte-for-byte untouched after successful validation", async () => {
      const authPath = "sample-repo/auth.js";
      const beforeBytes = fs.readFileSync(authPath);
      const beforeStat = fs.statSync(authPath);

      const plan = await validateProposedChange(validJsProposal);
      assert.equal(plan.isValid, true);

      const afterBytes = fs.readFileSync(authPath);
      const afterStat = fs.statSync(authPath);

      assert.deepEqual(beforeBytes, afterBytes, "File bytes must be identical before and after validation");
      assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, "File modification timestamp must not change");
    });

    it("should ensure repository files on disk remain byte-for-byte untouched after failed validation", async () => {
      const authPath = "sample-repo/auth.js";
      const beforeBytes = fs.readFileSync(authPath);
      const beforeStat = fs.statSync(authPath);

      const brokenProposal: ProposedChange = {
        ...validJsProposal,
        proposedCode: "const invalid = { ; // broken",
      };

      const plan = await validateProposedChange(brokenProposal);
      assert.equal(plan.isValid, false);

      const afterBytes = fs.readFileSync(authPath);
      const afterStat = fs.statSync(authPath);

      assert.deepEqual(beforeBytes, afterBytes, "File bytes must remain identical even when validation fails");
      assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, "File mtime must remain identical even when validation fails");
    });
  });
});
