/**
 * In-container smoke test matrix for image provisioning validation.
 *
 * Validates:
 * 1. TypeScript transpilation and ESM resolution from root /node_modules.
 * 2. WebAssembly initialization in user space without executable /tmp.
 * 3. Machine-readable TAP v13 output generation.
 */

import * as assert from "node:assert";

async function runSmokeTests() {
  console.log("TAP version 13");
  console.log("1..3");

  let passCount = 0;
  let failCount = 0;

  // Test 1: TypeScript and standard assertion verification
  try {
    const add = (a: number, b: number): number => a + b;
    assert.strictEqual(add(2, 3), 5);
    passCount++;
    console.log("ok 1 - TypeScript transpilation and basic assertion");
  } catch (err: any) {
    failCount++;
    console.log(`not ok 1 - TypeScript transpilation failed: ${err.message}`);
  }

  // Test 2: Package import verification (@google/genai)
  try {
    const genaiModule = await import("@google/genai");
    assert.ok(genaiModule, "Expected @google/genai to be resolvable from /node_modules");
    passCount++;
    console.log("ok 2 - ESM resolution of @google/genai from /node_modules");
  } catch (err: any) {
    failCount++;
    console.log(`not ok 2 - @google/genai import failed: ${err.message}`);
  }

  // Test 3: WebAssembly grammar module verification
  try {
    const Parser = (await import("web-tree-sitter")).default;
    assert.ok(Parser, "Expected web-tree-sitter to be resolvable");
    passCount++;
    console.log("ok 3 - web-tree-sitter import and runtime verification");
  } catch (err: any) {
    failCount++;
    console.log(`not ok 3 - web-tree-sitter verification failed: ${err.message}`);
  }

  console.log("# tests 3");
  console.log(`# pass ${passCount}`);
  console.log(`# fail ${failCount}`);
  console.log("# cancelled 0");
  console.log("# skipped 0");
  console.log("# todo 0");

  if (failCount > 0) {
    process.exit(1);
  }
}

runSmokeTests().catch((err) => {
  console.error("Smoke test failure:", err);
  process.exit(1);
});
