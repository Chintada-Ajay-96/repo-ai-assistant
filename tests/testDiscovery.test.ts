import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  discoverTests,
  discoverTestsSync,
  validatePathInsideRoot,
  extractCleanStem,
  isTestFilePath,
  scoreCandidateTest,
  TestDiscoveryError,
  PathTraversalError,
  CONFIDENCE_THRESHOLD_HIGH,
  CONFIDENCE_THRESHOLD_LIKELY,
} from "../src/testDiscovery.js";

describe("testDiscovery - Read-Only Test Discovery Engine (Phase 5A)", () => {
  let tempFixtureDir: string;

  beforeEach(() => {
    tempFixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "repo-assistant-discovery-fixture-")
    );
  });

  afterEach(() => {
    if (tempFixtureDir && fs.existsSync(tempFixtureDir)) {
      try {
        fs.rmSync(tempFixtureDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure on Windows locks
      }
    }
  });

  function createFixtureFile(relPath: string, content: string = ""): string {
    const fullPath = path.join(tempFixtureDir, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  function hashDirectory(dir: string): Record<string, string> {
    const hashes: Record<string, string> = {};
    function walk(curr: string) {
      const entries = fs.readdirSync(curr, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(curr, entry.name);
        const rel = path.relative(dir, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(full);
          hashes[rel] = crypto.createHash("sha256").update(content).digest("hex");
        }
      }
    }
    walk(dir);
    return hashes;
  }

  describe("Stem and Path Utilities", () => {
    it("should extract clean stems from various test naming conventions", () => {
      assert.equal(extractCleanStem("auth.test.ts"), "auth");
      assert.equal(extractCleanStem("auth.spec.js"), "auth");
      assert.equal(extractCleanStem("auth_test.ts"), "auth");
      assert.equal(extractCleanStem("auth-test.jsx"), "auth");
      assert.equal(extractCleanStem("auth.tests.tsx"), "auth");
      assert.equal(extractCleanStem("test_auth.js"), "auth");
      assert.equal(extractCleanStem("service.ts"), "service");
      assert.equal(extractCleanStem("src/utils/walkRepo.ts"), "walkRepo");
    });

    it("should accurately identify test file paths and exclude non-tests", () => {
      assert.ok(isTestFilePath("src/auth.test.ts"));
      assert.ok(isTestFilePath("tests/auth.spec.js"));
      assert.ok(isTestFilePath("tests/unit/token.ts"));
      assert.ok(isTestFilePath("__tests__/service.js"));
      assert.ok(isTestFilePath("spec/calculator.ts"));
      assert.ok(isTestFilePath("test_math.js"));

      // Non-test source files
      assert.ok(!isTestFilePath("src/auth.ts"));
      assert.ok(!isTestFilePath("src/index.js"));
      assert.ok(!isTestFilePath("package.json"));
      assert.ok(!isTestFilePath("README.md"));

      // Fixtures or mock files without test markers should not be treated as test suites
      assert.ok(!isTestFilePath("tests/fixtures/js/math.js"));
      assert.ok(!isTestFilePath("src/__mocks__/api.ts"));
      // Fixtures that explicitly are test files should be accepted
      assert.ok(isTestFilePath("tests/fixtures/sample.test.ts"));
    });
  });

  describe("Exact Filename Matches", () => {
    it("should discover co-located test matching exact stem with high confidence", async () => {
      createFixtureFile("src/auth.ts", "export function verifyToken() {}");
      createFixtureFile(
        "src/auth.test.ts",
        "describe('auth', () => { it('works', () => {}); });"
      );

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/auth.ts",
      });

      assert.equal(result.targetFile, "src/auth.ts");
      assert.equal(result.targetFileExists, true);
      assert.equal(result.hasLikelyTests, true);
      assert.equal(result.tests.length, 1);

      const top = result.tests[0]!;
      assert.equal(top.filePath, "src/auth.test.ts");
      assert.ok(top.confidence >= CONFIDENCE_THRESHOLD_HIGH);
      assert.equal(top.confidenceTier, "high");
      assert.ok(top.matchReasons.some((r) => r.includes("Exact filename stem match")));
      assert.ok(top.matchReasons.some((r) => r.includes("Co-located")));
    });
  });

  describe("Nearby Directory Matching", () => {
    it("should discover tests located in subfolder __tests__ of target directory", async () => {
      createFixtureFile("src/services/payment.ts", "export class Payment {}");
      createFixtureFile(
        "src/services/__tests__/payment.test.ts",
        "it('charges card', () => {});"
      );

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/services/payment.ts",
      });

      assert.equal(result.hasLikelyTests, true);
      assert.ok(result.tests.length >= 1);
      const test = result.tests[0]!;
      assert.equal(test.filePath, "src/services/__tests__/payment.test.ts");
      assert.ok(test.matchReasons.some((r) => r.includes("test subfolder under target directory")));
    });

    it("should discover tests located in adjacent tests/ subfolder (e.g. sample-repo/tests/)", async () => {
      createFixtureFile("sample-repo/auth.js", "function verifyToken() {}");
      createFixtureFile("sample-repo/tests/auth.test.js", "describe('auth', () => {});");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "sample-repo/auth.js",
      });

      assert.equal(result.hasLikelyTests, true);
      assert.equal(result.tests[0]?.filePath, "sample-repo/tests/auth.test.js");
    });
  });

  describe("Repository-Wide Test Conventions", () => {
    it("should discover tests in root tests/ mirroring relative path structure", async () => {
      createFixtureFile("src/utils/crypto.ts", "export function hash() {}");
      createFixtureFile("tests/utils/crypto.test.ts", "it('hashes strings', () => {});");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/utils/crypto.ts",
      });

      assert.equal(result.hasLikelyTests, true);
      assert.equal(result.tests[0]?.filePath, "tests/utils/crypto.test.ts");
      assert.ok(
        result.tests[0]?.matchReasons.some((r) =>
          r.includes("Mirrors target directory structure inside test folder")
        )
      );
    });

    it("should detect runner hints from configuration files on disk", async () => {
      createFixtureFile("src/app.ts", "console.log('app');");
      createFixtureFile("tests/app.test.ts", "it('app', () => {});");
      createFixtureFile("vitest.config.ts", "export default {};");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/app.ts",
      });

      const vitestHint = result.runnerHints.find((h) => h.runner === "vitest");
      assert.ok(vitestHint);
      assert.equal(vitestHint?.source, "config_file");
      assert.ok(vitestHint?.details.includes("vitest.config.ts"));
    });
  });

  describe("Symbol-Guided Matching & Boosting", () => {
    it("should boost confidence score when target symbol is referenced in test file content", async () => {
      createFixtureFile("src/auth.ts", "export function verifyToken(token) {}");
      createFixtureFile(
        "tests/auth.test.ts",
        "describe('auth', () => { it('calls verifyToken', () => { verifyToken('xyz'); }); });"
      );
      createFixtureFile(
        "tests/other.test.ts",
        "describe('other', () => { it('does something', () => {}); });"
      );

      const withSymbol = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/auth.ts",
        targetSymbol: "verifyToken",
      });

      const withoutSymbol = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/auth.ts",
      });

      const topWith = withSymbol.tests[0]!;
      const topWithout = withoutSymbol.tests[0]!;

      assert.equal(topWith.filePath, "tests/auth.test.ts");
      assert.ok(topWith.confidence > topWithout.confidence);
      assert.ok(
        topWith.matchReasons.some((r) =>
          r.includes("Symbol 'verifyToken' explicitly referenced in test file content")
        )
      );
    });
  });

  describe("No Matching Tests", () => {
    it("should return hasLikelyTests = false when no tests correlate with target file", async () => {
      createFixtureFile("src/lonely.ts", "export const lone = 1;");
      createFixtureFile(
        "tests/unrelated.test.ts",
        "it('unrelated', () => {});"
      );

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/lonely.ts",
      });

      assert.equal(result.hasLikelyTests, false);
      // Candidates with < 0.40 confidence may be listed as low, but hasLikelyTests is false
      for (const t of result.tests) {
        assert.ok(t.confidence < CONFIDENCE_THRESHOLD_LIKELY);
      }
    });

    it("should return empty tests array when repository has zero test files", async () => {
      createFixtureFile("src/standalone.ts", "export const x = 42;");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/standalone.ts",
      });

      assert.equal(result.hasLikelyTests, false);
      assert.equal(result.tests.length, 0);
      assert.equal(result.totalTestFilesScanned, 0);
    });
  });

  describe("Package.json Inspection & Untrusted Data Safeguards", () => {
    it("should handle missing package.json cleanly without errors", async () => {
      createFixtureFile("src/index.ts", "console.log('hi');");
      createFixtureFile("tests/index.test.ts", "it('test', () => {});");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/index.ts",
      });

      assert.deepEqual(result.packageTestScripts, {});
      assert.deepEqual(result.runnerHints, []);
      assert.equal(result.hasLikelyTests, true);
    });

    it("should handle malformed package.json gracefully with a warning", async () => {
      createFixtureFile("src/index.ts", "console.log('hi');");
      createFixtureFile("package.json", "{ malformed json content ... missing quotes }");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/index.ts",
      });

      assert.deepEqual(result.packageTestScripts, {});
      assert.ok(result.warnings.some((w) => w.includes("Failed to parse package.json")));
    });

    it("should treat malicious package scripts as inert strings without executing them", async () => {
      createFixtureFile("src/index.ts", "console.log('hi');");
      const sentinelFile = path.join(tempFixtureDir, "executed_sentinel.txt");

      const maliciousScript = `node -e "require('fs').writeFileSync('${sentinelFile.replace(/\\/g, "\\\\")}', 'pwned')"`;
      createFixtureFile(
        "package.json",
        JSON.stringify({
          scripts: {
            test: maliciousScript,
            "test:malicious": "rmdir /s /q . || rm -rf /",
          },
        })
      );

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/index.ts",
      });

      // Proof 1: The malicious command was never executed
      assert.equal(fs.existsSync(sentinelFile), false);

      // Proof 2: Script values are captured as passive, inert strings
      assert.equal(result.packageTestScripts["test"], maliciousScript);
      assert.equal(
        result.packageTestScripts["test:malicious"],
        "rmdir /s /q . || rm -rf /"
      );
    });
  });

  describe("Path Traversal and Safety Validation", () => {
    it("should throw PathTraversalError when target file uses relative path traversal to escape root", () => {
      createFixtureFile("src/valid.ts", "console.log('ok');");

      assert.throws(
        () => {
          validatePathInsideRoot("../outside.ts", tempFixtureDir);
        },
        (err) => {
          assert.ok(err instanceof PathTraversalError);
          assert.ok(err.message.includes("escapes repository root"));
          return true;
        }
      );

      assert.throws(
        () => {
          discoverTestsSync({
            repoRoot: tempFixtureDir,
            targetFile: "../../etc/passwd",
          });
        },
        (err) => {
          assert.ok(err instanceof PathTraversalError);
          return true;
        }
      );
    });

    it("should throw PathTraversalError when absolute target path is outside repository root", () => {
      createFixtureFile("src/valid.ts", "console.log('ok');");
      const outsidePath = path.resolve(tempFixtureDir, "..", "forbidden.ts");

      assert.throws(
        () => {
          validatePathInsideRoot(outsidePath, tempFixtureDir);
        },
        (err) => {
          assert.ok(err instanceof PathTraversalError);
          return true;
        }
      );
    });

    it("should throw TestDiscoveryError when target file path is empty", () => {
      assert.throws(
        () => {
          discoverTestsSync({
            repoRoot: tempFixtureDir,
            targetFile: "   ",
          });
        },
        (err) => {
          assert.ok(err instanceof TestDiscoveryError);
          assert.ok(err.message.includes("cannot be empty"));
          return true;
        }
      );
    });

    it("should throw TestDiscoveryError when repository root does not exist", () => {
      const nonExistentDir = path.join(tempFixtureDir, "does-not-exist");
      assert.throws(
        () => {
          discoverTestsSync({
            repoRoot: nonExistentDir,
            targetFile: "src/index.ts",
          });
        },
        (err) => {
          assert.ok(err instanceof TestDiscoveryError);
          assert.ok(err.message.includes("does not exist"));
          return true;
        }
      );
    });
  });

  describe("Missing or Unreadable Target Files", () => {
    it("should handle missing target file gracefully while still discovering candidate tests", async () => {
      // Test file exists, but target source file has not been created or was deleted
      createFixtureFile("tests/unwritten.test.ts", "it('test', () => {});");

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/unwritten.ts",
      });

      assert.equal(result.targetFileExists, false);
      assert.equal(result.targetFileReadable, false);
      assert.ok(result.warnings.some((w) => w.includes("does not exist on disk")));
      // Candidate test matching stem 'unwritten' should still be discovered
      assert.equal(result.hasLikelyTests, true);
      assert.equal(result.tests[0]?.filePath, "tests/unwritten.test.ts");
    });
  });

  describe("Deterministic Ranking", () => {
    it("should sort candidate tests deterministically across multiple runs", async () => {
      createFixtureFile("src/models/user.ts", "export class User {}");

      // Multiple candidate test files with varying degrees of correlation
      createFixtureFile("src/models/user.test.ts", "it('co-located', () => {});");
      createFixtureFile("tests/models/user.test.ts", "it('mirrored', () => {});");
      createFixtureFile("tests/user.spec.ts", "it('general stem', () => {});");
      createFixtureFile("tests/userHelper.test.ts", "it('partial stem', () => {});");
      createFixtureFile("tests/zeta_unrelated.test.ts", "it('unrelated z', () => {});");
      createFixtureFile("tests/alpha_unrelated.test.ts", "it('unrelated a', () => {});");

      const results = [];
      for (let i = 0; i < 5; i++) {
        const res = discoverTestsSync({
          repoRoot: tempFixtureDir,
          targetFile: "src/models/user.ts",
        });
        results.push(res.tests.map((t) => t.filePath));
      }

      // Verify that all 5 runs yielded the exact same ordering
      const firstRun = results[0]!;
      for (let i = 1; i < results.length; i++) {
        assert.deepEqual(results[i], firstRun);
      }

      // First place should be co-located exact stem match
      assert.equal(firstRun[0], "src/models/user.test.ts");
      // Followed by mirrored exact stem match
      assert.equal(firstRun[1], "tests/models/user.test.ts");
    });
  });

  describe("Confidence Normalization and Clamping", () => {
    it("should clamp candidate confidence scores strictly to [0.00, 1.00]", async () => {
      // Co-located exact stem match + symbol match gives cumulative weights: 0.50 + 0.25 + 0.25 = 1.00
      createFixtureFile("src/auth.ts", "export function verifyToken() {}");
      createFixtureFile(
        "src/auth.test.ts",
        "describe('auth', () => { it('checks verifyToken', () => { verifyToken(); }); });"
      );

      const scored = scoreCandidateTest(
        "src/auth.test.ts",
        "src/auth.ts",
        "auth",
        "verifyToken",
        true
      );

      assert.ok(scored.confidence >= 0.0);
      assert.ok(scored.confidence <= 1.0);
      assert.equal(scored.confidence, 1.0);

      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/auth.ts",
        targetSymbol: "verifyToken",
      });

      assert.equal(result.hasLikelyTests, true);
      for (const t of result.tests) {
        assert.ok(t.confidence >= 0.0, `Score ${t.confidence} must be >= 0.0`);
        assert.ok(t.confidence <= 1.0, `Score ${t.confidence} must be <= 1.0`);
      }
    });
  });

  describe("Symbolic Link Path Containment", () => {
    it("should reject target file that resolves via symbolic link outside repoRoot", () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "repo-assistant-outside-target-")
      );
      const outsideFile = path.join(outsideDir, "secret.ts");
      fs.writeFileSync(outsideFile, "export const secret = 123;", "utf8");

      try {
        const linkDir = path.join(tempFixtureDir, "linked_outside");
        // On Windows, use 'junction'; on POSIX, use 'dir'
        const linkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(outsideDir, linkDir, linkType);

        assert.throws(
          () => {
            validatePathInsideRoot("linked_outside/secret.ts", tempFixtureDir);
          },
          (err) => {
            assert.ok(err instanceof PathTraversalError);
            assert.ok(err.message.includes("resolves via symbolic link outside"));
            return true;
          }
        );
      } finally {
        try {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it("should safely ignore scanned directory symlinks pointing outside repoRoot", async () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "repo-assistant-outside-scan-")
      );
      const outsideTest = path.join(outsideDir, "app.test.ts");
      fs.writeFileSync(outsideTest, "it('outside test', () => {});", "utf8");

      try {
        createFixtureFile("src/app.ts", "export const app = true;");
        const linkDir = path.join(tempFixtureDir, "escaped_tests");
        const linkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(outsideDir, linkDir, linkType);

        const result = await discoverTests({
          repoRoot: tempFixtureDir,
          targetFile: "src/app.ts",
        });

        // The symlinked test outside repoRoot must be skipped
        const foundOutside = result.tests.some((t) => t.filePath.includes("escaped_tests"));
        assert.equal(foundOutside, false);
      } finally {
        try {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it("should prevent infinite loops when a symlink cycle exists inside repoRoot", async () => {
      createFixtureFile("src/calc.ts", "export const x = 1;");
      createFixtureFile("tests/calc.test.ts", "it('works', () => {});");

      const cycleDir = path.join(tempFixtureDir, "cycle_dir");
      fs.mkdirSync(cycleDir, { recursive: true });

      const linkPath = path.join(cycleDir, "loop_back");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      try {
        fs.symlinkSync(tempFixtureDir, linkPath, linkType);
      } catch {
        // If system forbids cyclic junction, test is vacuously satisfied
        return;
      }

      // Traversal must complete without stack overflow / infinite recursion
      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/calc.ts",
      });

      assert.equal(result.hasLikelyTests, true);
      assert.equal(result.tests[0]?.filePath, "tests/calc.test.ts");
    });
  });

  describe("Proof of Non-destructive Read-Only Operation", () => {
    it("should guarantee that repository files are never modified, deleted, or added during discovery", async () => {
      createFixtureFile("src/calculator.ts", "export const add = (a, b) => a + b;");
      createFixtureFile("tests/calculator.test.ts", "it('adds', () => {});");
      createFixtureFile(
        "package.json",
        JSON.stringify({
          name: "fixture-repo",
          scripts: { test: "tsx --test tests/**/*.test.ts" },
        })
      );

      // Snapshot all files and content hashes before discovery
      const hashesBefore = hashDirectory(tempFixtureDir);

      // Execute discovery
      const result = await discoverTests({
        repoRoot: tempFixtureDir,
        targetFile: "src/calculator.ts",
        targetSymbol: "add",
      });

      assert.equal(result.hasLikelyTests, true);

      // Snapshot all files and content hashes after discovery
      const hashesAfter = hashDirectory(tempFixtureDir);

      // Verify 100% byte-for-byte identity and zero new/deleted files
      assert.deepEqual(hashesAfter, hashesBefore);
    });
  });
});
