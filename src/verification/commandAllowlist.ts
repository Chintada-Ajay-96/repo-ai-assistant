import * as path from "node:path";
import {
  type ApprovedTestCommand,
  PathValidationError,
  PathTraversalError,
  SecurityPolicyError,
} from "./types.js";
import { type TestDiscoveryResult, type DiscoveredCandidateTest } from "../testDiscovery.js";

/**
 * Supported test file extensions inside the verification container.
 */
export const ALLOWED_TEST_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);

/**
 * Validates a candidate test path string against directory traversal,
 * Windows separator/drive bypasses, and extension restrictions.
 */
export function validateCandidateTestPath(testPath: string): string {
  if (!testPath || typeof testPath !== "string") {
    throw new PathValidationError("Candidate test path must be a non-empty string");
  }

  // Reject Windows drive prefixes, backslashes, null bytes, and UNC prefixes
  if (testPath.includes(":") || testPath.includes("\\") || testPath.includes("\0")) {
    throw new PathValidationError(
      `Candidate test path contains illegal characters, drive prefixes, or Windows backslashes: "${testPath}"`
    );
  }

  if (testPath.startsWith("//") || testPath.startsWith("\\\\")) {
    throw new PathValidationError(
      `UNC or device namespace paths are strictly forbidden: "${testPath}"`
    );
  }

  // Posix normalization check
  const normalized = path.posix.normalize(testPath);
  if (normalized !== testPath || path.posix.isAbsolute(testPath) || normalized.startsWith("..")) {
    throw new PathTraversalError(
      `Candidate test path must be a canonical relative path without traversal: "${testPath}"`,
      testPath,
      ""
    );
  }

  // Validate permitted extension
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ALLOWED_TEST_EXTENSIONS.has(ext)) {
    throw new SecurityPolicyError(
      `Test file extension "${ext}" is not permitted for isolated verification. Allowed: ${Array.from(ALLOWED_TEST_EXTENSIONS).join(", ")}`
    );
  }

  return normalized;
}

/**
 * Resolves an immutable, allowlisted test execution command based strictly
 * on discovered candidate tests and the fixed container runner profile.
 *
 * Package scripts from package.json and arbitrary user/LLM commands are strictly ignored.
 */
export function resolveApprovedTestCommand(
  testDiscovery: TestDiscoveryResult,
  selectedTestPaths?: string[] | undefined
): ApprovedTestCommand {
  // If caller specified explicit paths, validate they exist within discovered candidate tests
  let candidatePaths: string[];

  if (selectedTestPaths && selectedTestPaths.length > 0) {
    const discoveredPaths = new Set(testDiscovery.tests.map((t) => t.filePath));
    for (const explicitPath of selectedTestPaths) {
      if (!discoveredPaths.has(explicitPath)) {
        throw new SecurityPolicyError(
          `Selected test path "${explicitPath}" is not among discovered candidate tests for this change.`
        );
      }
    }
    candidatePaths = selectedTestPaths;
  } else {
    // Select tests with high or medium confidence
    const eligibleTests = testDiscovery.tests.filter(
      (t) => t.confidenceTier === "high" || t.confidenceTier === "medium"
    );

    // Fall back to all discovered tests if none are in high/medium tiers
    const targetList = eligibleTests.length > 0 ? eligibleTests : testDiscovery.tests;
    candidatePaths = targetList.map((t) => t.filePath);
  }

  if (candidatePaths.length === 0) {
    throw new SecurityPolicyError(
      "No candidate test files available for verification. Verification requires at least one candidate test."
    );
  }

  // Validate every single candidate path
  const validatedFiles: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of candidatePaths) {
    const validated = validateCandidateTestPath(rawPath);
    if (!seen.has(validated)) {
      seen.add(validated);
      validatedFiles.push(validated);
    }
  }

  return {
    runnerId: "tsx-node-test",
    executable: "/node_modules/.bin/tsx",
    args: ["--test", "--test-reporter=tap", ...validatedFiles],
    targetTestFiles: validatedFiles,
  };
}
