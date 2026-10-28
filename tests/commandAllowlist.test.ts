import test from "node:test";
import * as assert from "node:assert";
import {
  validateCandidateTestPath,
  resolveApprovedTestCommand,
} from "../src/verification/commandAllowlist.js";
import {
  PathValidationError,
  PathTraversalError,
  SecurityPolicyError,
} from "../src/verification/types.js";
import { type TestDiscoveryResult } from "../src/testDiscovery.js";

test("commandAllowlist - Safe Test Command Construction & Path Validation", async (t) => {
  await t.test("should accept canonical, relative test paths with allowed extensions", () => {
    assert.strictEqual(
      validateCandidateTestPath("tests/codeChunks.test.ts"),
      "tests/codeChunks.test.ts"
    );
    assert.strictEqual(
      validateCandidateTestPath("tests/integration.spec.js"),
      "tests/integration.spec.js"
    );
    assert.strictEqual(
      validateCandidateTestPath("tests/fixtures/sample.test.tsx"),
      "tests/fixtures/sample.test.tsx"
    );
  });

  await t.test("should reject path traversal attempts", () => {
    assert.throws(
      () => validateCandidateTestPath("../secret.test.ts"),
      PathTraversalError
    );
    assert.throws(
      () => validateCandidateTestPath("tests/../../secret.test.ts"),
      PathTraversalError
    );
    assert.throws(
      () => validateCandidateTestPath("/tests/codeChunks.test.ts"),
      PathTraversalError
    );
  });

  await t.test("should reject Windows drive prefixes and backslashes", () => {
    assert.throws(
      () => validateCandidateTestPath("C:tests/foo.test.ts"),
      PathValidationError
    );
    assert.throws(
      () => validateCandidateTestPath("D:/tests/foo.test.ts"),
      PathValidationError
    );
    assert.throws(
      () => validateCandidateTestPath("tests\\foo.test.ts"),
      PathValidationError
    );
  });

  await t.test("should reject UNC and device namespace paths", () => {
    assert.throws(
      () => validateCandidateTestPath("//server/share/test.ts"),
      PathValidationError
    );
    assert.throws(
      () => validateCandidateTestPath("\\\\?\\C:\\test.ts"),
      PathValidationError
    );
  });

  await t.test("should reject null byte injection", () => {
    assert.throws(
      () => validateCandidateTestPath("tests/test.ts\0.exe"),
      PathValidationError
    );
  });

  await t.test("should reject disallowed extensions", () => {
    assert.throws(
      () => validateCandidateTestPath("tests/script.sh"),
      SecurityPolicyError
    );
    assert.throws(
      () => validateCandidateTestPath("tests/binary.exe"),
      SecurityPolicyError
    );
    assert.throws(
      () => validateCandidateTestPath("tests/test.py"),
      SecurityPolicyError
    );
  });

  await t.test("should resolve approved test command filtering to high/medium confidence", () => {
    const mockDiscovery: TestDiscoveryResult = {
      repoRoot: process.cwd(),
      targetFile: "src/auth.ts",
      targetFileExists: true,
      targetFileReadable: true,
      hasLikelyTests: true,
      tests: [
        {
          filePath: "tests/auth.test.ts",
          absolutePath: "/repo/tests/auth.test.ts",
          confidence: 0.9,
          confidenceTier: "high",
          matchReasons: ["stem match"],
        },
        {
          filePath: "tests/authHelper.test.ts",
          absolutePath: "/repo/tests/authHelper.test.ts",
          confidence: 0.5,
          confidenceTier: "medium",
          matchReasons: ["directory proximity"],
        },
        {
          filePath: "tests/unrelated.test.ts",
          absolutePath: "/repo/tests/unrelated.test.ts",
          confidence: 0.2,
          confidenceTier: "low",
          matchReasons: ["fallback"],
        },
      ],
      runnerHints: [{ runner: "node-test", source: "package_scripts", details: "npm test" }],
      packageTestScripts: { test: "tsx --test tests/**/*.test.ts" },
      totalTestFilesScanned: 3,
      warnings: [],
    };

    const cmd = resolveApprovedTestCommand(mockDiscovery);
    assert.strictEqual(cmd.runnerId, "tsx-node-test");
    assert.strictEqual(cmd.executable, "/node_modules/.bin/tsx");
    assert.deepStrictEqual(cmd.args, [
      "--test",
      "--test-reporter=tap",
      "tests/auth.test.ts",
      "tests/authHelper.test.ts",
    ]);
    assert.deepStrictEqual(cmd.targetTestFiles, [
      "tests/auth.test.ts",
      "tests/authHelper.test.ts",
    ]);
  });

  await t.test("should reject command resolution when zero tests exist", () => {
    const emptyDiscovery: TestDiscoveryResult = {
      repoRoot: process.cwd(),
      targetFile: "src/auth.ts",
      targetFileExists: true,
      targetFileReadable: true,
      hasLikelyTests: false,
      tests: [],
      runnerHints: [],
      packageTestScripts: {},
      totalTestFilesScanned: 0,
      warnings: [],
    };

    assert.throws(
      () => resolveApprovedTestCommand(emptyDiscovery),
      SecurityPolicyError
    );
  });

  await t.test("should reject command resolution when only low-confidence tests exist without suitable candidates", () => {
    const lowConfidenceDiscovery: TestDiscoveryResult = {
      repoRoot: process.cwd(),
      targetFile: "src/untested.ts",
      targetFileExists: true,
      targetFileReadable: true,
      hasLikelyTests: false,
      tests: [
        {
          filePath: "tests/unrelated.test.ts",
          absolutePath: "/repo/tests/unrelated.test.ts",
          confidence: 0.1,
          confidenceTier: "low",
          matchReasons: ["Located in recognized test directory ('tests')"],
        },
      ],
      runnerHints: [],
      packageTestScripts: {},
      totalTestFilesScanned: 1,
      warnings: [],
    };

    assert.throws(
      () => resolveApprovedTestCommand(lowConfidenceDiscovery),
      (err: any) => {
        return (
          err instanceof SecurityPolicyError &&
          err.message.includes("No candidate test files with sufficient confidence")
        );
      }
    );
  });

  await t.test("should accept explicit selectedTestPaths when they match discovered tests", () => {
    const mockDiscovery: TestDiscoveryResult = {
      repoRoot: process.cwd(),
      targetFile: "src/auth.ts",
      targetFileExists: true,
      targetFileReadable: true,
      hasLikelyTests: true,
      tests: [
        {
          filePath: "tests/auth.test.ts",
          absolutePath: "/repo/tests/auth.test.ts",
          confidence: 0.9,
          confidenceTier: "high",
          matchReasons: ["stem match"],
        },
      ],
      runnerHints: [],
      packageTestScripts: {},
      totalTestFilesScanned: 1,
      warnings: [],
    };

    const cmd = resolveApprovedTestCommand(mockDiscovery, ["tests/auth.test.ts"]);
    assert.deepStrictEqual(cmd.targetTestFiles, ["tests/auth.test.ts"]);
  });

  await t.test("should reject explicit selectedTestPaths when not discovered for target file", () => {
    const mockDiscovery: TestDiscoveryResult = {
      repoRoot: process.cwd(),
      targetFile: "src/auth.ts",
      targetFileExists: true,
      targetFileReadable: true,
      hasLikelyTests: true,
      tests: [
        {
          filePath: "tests/auth.test.ts",
          absolutePath: "/repo/tests/auth.test.ts",
          confidence: 0.9,
          confidenceTier: "high",
          matchReasons: ["stem match"],
        },
      ],
      runnerHints: [],
      packageTestScripts: {},
      totalTestFilesScanned: 1,
      warnings: [],
    };

    assert.throws(
      () => resolveApprovedTestCommand(mockDiscovery, ["tests/undiscovered.test.ts"]),
      (err: any) => err instanceof SecurityPolicyError && err.message.includes("not among discovered candidate tests")
    );
  });
});
