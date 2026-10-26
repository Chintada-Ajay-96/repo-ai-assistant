import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  stageWorkspace,
  validateAndResolveTargetPath,
  executeBoundedStagingCleanup,
  safeRecordBookkeeping,
  PENDING_CLEANUP_SPOOL,
} from "../src/verification/workspaceStager.js";
import {
  PathValidationError,
  PathTraversalError,
  SecurityPolicyError,
  StagingLayoutError,
} from "../src/verification/types.js";
import { type ProposedChange } from "../src/changeGenerator.js";

test("workspaceStager - Workspace Staging, Containment & Bounded Cleanup Suite", async (t) => {
  // Create a minimal fixture repo on disk for staging tests
  const fixtureRoot = path.join(os.tmpdir(), `stager-test-fixture-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "tests"), { recursive: true });

  fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "fixture" }));
  fs.writeFileSync(path.join(fixtureRoot, "tsconfig.json"), JSON.stringify({}));
  fs.writeFileSync(path.join(fixtureRoot, ".env"), "SECRET_API_KEY=topsecret");
  fs.writeFileSync(path.join(fixtureRoot, "src", "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  fs.writeFileSync(path.join(fixtureRoot, "tests", "math.test.ts"), "import { add } from '../src/math.js';\n");

  t.after(() => {
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {
      // ignore fixture cleanup errors
    }
  });

  await t.test("should stage allowlisted files while excluding secrets and sensitive directories", async () => {
    const proposal: ProposedChange = {
      file: "src/math.ts",
      symbol: "add",
      targetFile: "src/math.ts",
      targetSymbol: "add",
      startLine: 1,
      endLine: 1,
      originalCode: "export function add(a: number, b: number) { return a + b; }",
      proposedCode: "export function add(a: number, b: number): number { return a + b; }",
      diff: "@@ -1 +1 @@",
      explanation: "Add explicit return type",
    };

    const staged = await stageWorkspace(fixtureRoot, proposal);
    try {
      assert.strictEqual(staged.isNoOp, false);
      assert.ok(fs.existsSync(staged.stagingPath));
      assert.ok(fs.existsSync(path.join(staged.stagingPath, "package.json")));
      assert.ok(fs.existsSync(path.join(staged.stagingPath, "src", "math.ts")));
      assert.ok(fs.existsSync(path.join(staged.stagingPath, "tests", "math.test.ts")));

      // Assert .env is strictly excluded
      assert.strictEqual(fs.existsSync(path.join(staged.stagingPath, ".env")), false);

      // Verify that the patched content was written strictly to the target file
      const patchedContent = fs.readFileSync(path.join(staged.stagingPath, "src", "math.ts"), "utf8");
      assert.ok(patchedContent.includes(": number"));
    } finally {
      const cleanupResult = await staged.cleanup();
      assert.strictEqual(cleanupResult.cleanupStatus, "cleaned");
      assert.strictEqual(fs.existsSync(staged.stagingPath), false);
    }
  });

  await t.test("should detect No-Op proposal when proposed code is identical to disk", async () => {
    const noOpProposal: ProposedChange = {
      file: "src/math.ts",
      symbol: "add",
      targetFile: "src/math.ts",
      targetSymbol: "add",
      startLine: 1,
      endLine: 1,
      originalCode: "export function add(a: number, b: number) { return a + b; }",
      proposedCode: "export function add(a: number, b: number) { return a + b; }",
      diff: "",
      explanation: "No change",
    };

    const staged = await stageWorkspace(fixtureRoot, noOpProposal);
    try {
      assert.strictEqual(staged.isNoOp, true);
    } finally {
      await staged.cleanup();
    }
  });

  await t.test("should reject target paths with traversal or illegal syntax", () => {
    assert.throws(
      () => validateAndResolveTargetPath(fixtureRoot, "../outside.ts"),
      PathTraversalError
    );
    assert.throws(
      () => validateAndResolveTargetPath(fixtureRoot, "C:src/math.ts"),
      PathValidationError
    );
    assert.throws(
      () => validateAndResolveTargetPath(fixtureRoot, "src\\math.ts"),
      PathValidationError
    );
  });

  await t.test("should fail closed with StagingLayoutError when intermediate directory is missing", () => {
    assert.throws(
      () => validateAndResolveTargetPath(fixtureRoot, "src/missing_dir/helper.ts"),
      StagingLayoutError
    );
  });

  await t.test("should reject target file outside permitted staging allowlist", () => {
    assert.throws(
      () => validateAndResolveTargetPath(fixtureRoot, "package.json"),
      SecurityPolicyError
    );
  });

  await t.test("safeRecordBookkeeping should safely absorb both synchronous throws and asynchronous rejections", () => {
    // Synchronous throw
    assert.doesNotThrow(() => {
      safeRecordBookkeeping(() => {
        throw new Error("Synchronous logging error");
      });
    });

    // Asynchronous rejection
    assert.doesNotThrow(() => {
      safeRecordBookkeeping(() => {
        return Promise.reject(new Error("Asynchronous bookkeeping rejection"));
      });
    });
  });

  await t.test("should handle bounded cleanup timeout gracefully and report residual path", async () => {
    const dummyDir = path.join(os.tmpdir(), `cleanup-timeout-test-${crypto.randomUUID()}`);
    fs.mkdirSync(dummyDir, { recursive: true });

    // Calling executeBoundedStagingCleanup with 0ms timeout to simulate caller deadline expiration
    const result = await executeBoundedStagingCleanup(dummyDir, 0);

    assert.strictEqual(result.cleanupStatus, "failed");
    assert.strictEqual(result.residualPath, dummyDir);
    assert.ok(result.warning?.includes("cleanup wait timed out"));
    assert.ok(PENDING_CLEANUP_SPOOL.has(dummyDir));

    // Clean up actual dummy directory
    fs.rmSync(dummyDir, { recursive: true, force: true });
    PENDING_CLEANUP_SPOOL.delete(dummyDir);
  });
});
