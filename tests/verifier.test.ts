import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { verifyProposedChange } from "../src/verification/verifier.js";
import {
  type VerificationRequest,
  type ValidatedChangePlan,
} from "../src/verification/types.js";
import {
  type IDockerExecutor,
  type ContainerRunResult,
} from "../src/verification/dockerSandbox.js";
import { VERIFICATION_IMAGE } from "../src/verification/imageConfig.js";
import { type TestDiscoveryResult } from "../src/testDiscovery.js";

test("verifier - End-to-End Isolated Verification Orchestrator Suite", async (t) => {
  // Create a minimal host test fixture repository
  const repoRoot = path.join(os.tmpdir(), `verifier-test-repo-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "tests"), { recursive: true });

  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "fixture-repo" }));
  fs.writeFileSync(path.join(repoRoot, "tsconfig.json"), JSON.stringify({}));
  fs.writeFileSync(
    path.join(repoRoot, "src", "calculator.ts"),
    "export function calculateTotal(items: number[]): number {\n  return items.reduce((acc, x) => acc + x, 0);\n}\n"
  );
  fs.writeFileSync(
    path.join(repoRoot, "tests", "calculator.test.ts"),
    "import { calculateTotal } from '../src/calculator.js';\n"
  );

  const originalImageProvisioned = VERIFICATION_IMAGE.isProvisioned;
  const originalExpectedImageId = VERIFICATION_IMAGE.expectedImageId;

  t.after(() => {
    try {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    (VERIFICATION_IMAGE as any).isProvisioned = originalImageProvisioned;
    (VERIFICATION_IMAGE as any).expectedImageId = originalExpectedImageId;
  });

  const validPlan: ValidatedChangePlan = {
    isValid: true,
    proposal: {
      file: "src/calculator.ts",
      symbol: "calculateTotal",
      targetFile: "src/calculator.ts",
      targetSymbol: "calculateTotal",
      startLine: 1,
      endLine: 3,
      originalCode: "export function calculateTotal(items: number[]): number {\n  return items.reduce((acc, x) => acc + x, 0);\n}",
      proposedCode: "export function calculateTotal(items: number[]): number {\n  if (!items || items.length === 0) return 0;\n  return items.reduce((acc, x) => acc + x, 0);\n}",
      diff: "@@ -1,3 +1,4 @@",
      explanation: "Add null check",
    },
    checks: [],
    preview: "Diff preview",
    syntaxNotice: "AST syntax valid",
  };

  const validDiscovery: TestDiscoveryResult = {
    repoRoot,
    targetFile: "src/calculator.ts",
    targetFileExists: true,
    targetFileReadable: true,
    hasLikelyTests: true,
    tests: [
      {
        filePath: "tests/calculator.test.ts",
        absolutePath: path.join(repoRoot, "tests", "calculator.test.ts"),
        confidence: 0.95,
        confidenceTier: "high",
        matchReasons: ["Exact stem match"],
      },
    ],
    runnerHints: [{ runner: "node-test", source: "package_scripts", details: "npm test" }],
    packageTestScripts: {},
    totalTestFilesScanned: 1,
    warnings: [],
  };

  await t.test("should fail closed with status: error when change plan is invalid", async () => {
    const invalidPlan: ValidatedChangePlan = {
      ...validPlan,
      isValid: false,
      failureReason: "Tree-sitter AST syntax error: unmatched brace",
    };

    const result = await verifyProposedChange({
      validatedPlan: invalidPlan,
      testDiscovery: validDiscovery,
      repoRoot,
    });

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.environment, "none");
    assert.ok(result.failureReason?.includes("Change validation failed"));
  });

  await t.test("should return status: unavailable when forceUnavailable is true", async () => {
    const result = await verifyProposedChange({
      validatedPlan: validPlan,
      testDiscovery: validDiscovery,
      repoRoot,
      options: { forceUnavailable: true },
    });

    assert.strictEqual(result.status, "unavailable");
    assert.ok(result.failureReason?.includes("explicitly forced"));
  });

  await t.test("should return status: unavailable when Docker runtime is not available", async () => {
    const mockUnavailableExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: false, reason: "Docker Desktop named pipe is not accessible" };
      },
      async inspectImageId() {
        return { matches: false };
      },
      async runCanaryWriteProbe() {
        return { success: false };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        throw new Error("Should not be called");
      },
    };

    const result = await verifyProposedChange(
      {
        validatedPlan: validPlan,
        testDiscovery: validDiscovery,
        repoRoot,
      },
      mockUnavailableExecutor
    );

    assert.strictEqual(result.status, "unavailable");
    assert.ok(result.failureReason?.includes("named pipe is not accessible"));
  });

  await t.test("should return status: unavailable when image is unprovisioned", async () => {
    const prevProvisioned = VERIFICATION_IMAGE.isProvisioned;
    const prevId = VERIFICATION_IMAGE.expectedImageId;
    (VERIFICATION_IMAGE as any).isProvisioned = false;
    (VERIFICATION_IMAGE as any).expectedImageId = "";

    try {
      const mockExecutor: IDockerExecutor = {
        async checkAvailability() {
          return { available: true };
        },
        async inspectImageId() {
          return { matches: false };
        },
        async runCanaryWriteProbe() {
          return { success: true };
        },
        async executeTestRun(): Promise<ContainerRunResult> {
          throw new Error("Should not be called");
        },
      };

      const result = await verifyProposedChange(
        {
          validatedPlan: validPlan,
          testDiscovery: validDiscovery,
          repoRoot,
        },
        mockExecutor
      );

      assert.strictEqual(result.status, "unavailable");
      assert.ok(result.failureReason?.includes("Verification image is unprovisioned"));
    } finally {
      (VERIFICATION_IMAGE as any).isProvisioned = prevProvisioned;
      (VERIFICATION_IMAGE as any).expectedImageId = prevId;
    }
  });

  await t.test("should return status: failed when No-Op change proposal is detected", async () => {
    // Temporarily provision image config for test
    (VERIFICATION_IMAGE as any).isProvisioned = true;
    (VERIFICATION_IMAGE as any).expectedImageId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    t.after(() => {
      (VERIFICATION_IMAGE as any).isProvisioned = originalImageProvisioned;
      (VERIFICATION_IMAGE as any).expectedImageId = originalExpectedImageId;
    });

    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        throw new Error("Should not be called for no-op");
      },
    };

    const noOpPlan: ValidatedChangePlan = {
      ...validPlan,
      proposal: {
        ...validPlan.proposal,
        proposedCode: validPlan.proposal.originalCode, // Identical proposal
      },
    };

    const result = await verifyProposedChange(
      {
        validatedPlan: noOpPlan,
        testDiscovery: validDiscovery,
        repoRoot,
      },
      mockExecutor
    );

    assert.strictEqual(result.status, "failed");
    assert.ok(result.failureReason?.includes("No-op change detected"));
  });

  await t.test("should return status: passed and cleanupStatus: cleaned on successful test run", async () => {
    (VERIFICATION_IMAGE as any).isProvisioned = true;
    (VERIFICATION_IMAGE as any).expectedImageId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        return {
          exitCode: 0,
          stdout: `TAP version 13\n1..1\nok 1 - calculateTotal handles empty array\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
          stderr: "",
          outputTruncated: false,
          durationMs: 120,
          timedOut: false,
          outputLimitExceeded: false,
          containerStoppedConfirmed: true,
          warnings: [],
        };
      },
    };

    const result = await verifyProposedChange(
      {
        validatedPlan: validPlan,
        testDiscovery: validDiscovery,
        repoRoot,
      },
      mockExecutor
    );

    assert.strictEqual(result.status, "passed");
    assert.strictEqual(result.cleanupStatus, "cleaned");
    assert.strictEqual(result.executionSummary?.passed, 1);
    assert.strictEqual(result.executionSummary?.failed, 0);
  });

  await t.test("STATUS WITHHOLDING: should overrule passed status to error if cleanup fails", async () => {
    (VERIFICATION_IMAGE as any).isProvisioned = true;
    (VERIFICATION_IMAGE as any).expectedImageId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        return {
          exitCode: 0,
          stdout: `TAP version 13\n1..1\nok 1 - calculateTotal handles empty array\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
          stderr: "",
          outputTruncated: false,
          durationMs: 120,
          timedOut: false,
          outputLimitExceeded: false,
          containerStoppedConfirmed: false, // Container removal could NOT be confirmed!
          warnings: ["Warning: Container termination or removal could not be confirmed."],
        };
      },
    };

    const result = await verifyProposedChange(
      {
        validatedPlan: validPlan,
        testDiscovery: validDiscovery,
        repoRoot,
      },
      mockExecutor
    );

    // Passing status was strictly withheld because cleanup was unconfirmed!
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.cleanupStatus, "failed");
    assert.ok(result.failureReason?.includes("passing status was withheld"));
  });

  await t.test("should guarantee that host repository files remain byte-for-byte identical", async () => {
    (VERIFICATION_IMAGE as any).isProvisioned = true;
    (VERIFICATION_IMAGE as any).expectedImageId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const calcPath = path.join(repoRoot, "src", "calculator.ts");
    const preContent = fs.readFileSync(calcPath, "utf8");

    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        return {
          exitCode: 0,
          stdout: `TAP version 13\n1..1\nok 1 - pass\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
          stderr: "",
          outputTruncated: false,
          durationMs: 100,
          timedOut: false,
          outputLimitExceeded: false,
          containerStoppedConfirmed: true,
          warnings: [],
        };
      },
    };

    await verifyProposedChange(
      {
        validatedPlan: validPlan,
        testDiscovery: validDiscovery,
        repoRoot,
      },
      mockExecutor
    );

    const postContent = fs.readFileSync(calcPath, "utf8");
    assert.strictEqual(postContent, preContent, "Host repository file was mutated!");
  });
});
