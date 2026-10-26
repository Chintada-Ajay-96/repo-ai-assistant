import test from "node:test";
import * as assert from "node:assert";
import { parseTapStream, evaluateTapResult } from "../src/verification/tapParser.js";

test("tapParser - Synthetic TAP v13 Parser & Discrete Accounting Suite", async (t) => {
  await t.test("should parse a valid passing TAP v13 stream with clean summary", () => {
    const rawTap = `TAP version 13
1..2
ok 1 - math add function
ok 2 - string concatenation
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 42.5
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, true);
    assert.strictEqual(parsed.planCount, 2);
    assert.strictEqual(parsed.summaryTotal, 2);
    assert.strictEqual(parsed.discretePassed, 2);
    assert.strictEqual(parsed.discreteFailed, 0);
    assert.strictEqual(parsed.discreteSkipped, 0);
    assert.strictEqual(parsed.discreteTodo, 0);

    const evaluation = evaluateTapResult(parsed, 0, ["tests/math.test.ts"]);
    assert.strictEqual(evaluation.isPassed, true);
    assert.strictEqual(evaluation.summary.passed, 2);
    assert.strictEqual(evaluation.summary.failed, 0);
  });

  await t.test("should detect test failure from not ok line and fail summary", () => {
    const rawTap = `TAP version 13
1..2
ok 1 - auth initialization
not ok 2 - token expiration verification
  ---
  failure: Expected 200 but received 401
  ...
# tests 2
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, true);
    assert.strictEqual(parsed.discretePassed, 1);
    assert.strictEqual(parsed.discreteFailed, 1);

    const evaluation = evaluateTapResult(parsed, 1, ["tests/auth.test.ts"]);
    assert.strictEqual(evaluation.isPassed, false);
    assert.strictEqual(evaluation.summary.failed, 1);
    assert.ok(evaluation.failureReason?.includes("1 test assertion(s) failed"));
  });

  await t.test("should handle TODO expected failures without incrementing pass count", () => {
    const rawTap = `TAP version 13
1..2
not ok 1 - pending feature implementation # TODO under construction
not ok 2 - another draft feature # TODO under construction
# tests 2
# pass 0
# fail 0
# cancelled 0
# skipped 0
# todo 2
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, true);
    assert.strictEqual(parsed.discretePassed, 0);
    assert.strictEqual(parsed.discreteTodo, 2);
    assert.strictEqual(parsed.todoDetails.length, 2);
    assert.strictEqual(parsed.todoDetails[0]!.passedUnexpectedly, false);

    // All TODOs means zero active passes -> must fail verification
    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
    assert.ok(evaluation.failureReason?.includes("marked TODO"));
  });

  await t.test("should handle TODO unexpected passes without counting them as active passes", () => {
    const rawTap = `TAP version 13
1..1
ok 1 - bonus pass on draft feature # TODO under construction
# tests 1
# pass 0
# fail 0
# cancelled 0
# skipped 0
# todo 1
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, true);
    assert.strictEqual(parsed.discretePassed, 0);
    assert.strictEqual(parsed.discreteTodo, 1);
    assert.strictEqual(parsed.todoDetails[0]!.passedUnexpectedly, true);

    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
  });

  await t.test("should handle SKIP tests and pass with skip details when at least one test passed", () => {
    const rawTap = `TAP version 13
1..2
ok 1 - baseline unit test
ok 2 - optional integration test # SKIP requires external service
# tests 2
# pass 1
# fail 0
# cancelled 0
# skipped 1
# todo 0
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, true);
    assert.strictEqual(parsed.discretePassed, 1);
    assert.strictEqual(parsed.discreteSkipped, 1);
    assert.strictEqual(parsed.skippedDetails.length, 1);
    assert.strictEqual(parsed.skippedDetails[0]!.reason, "requires external service");

    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, true);
    assert.strictEqual(evaluation.summary.skipped, 1);
  });

  await t.test("should fail when all tests are skipped (zero active assertions verified)", () => {
    const rawTap = `TAP version 13
1..2
ok 1 - test a # SKIP reason
ok 2 - test b # SKIP reason
# tests 2
# pass 0
# fail 0
# cancelled 0
# skipped 2
# todo 0
`;

    const parsed = parseTapStream(rawTap);
    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
    assert.ok(evaluation.failureReason?.includes("All 2 candidate test(s) were skipped"));
  });

  await t.test("should fail when zero tests executed in suite", () => {
    const rawTap = `TAP version 13
1..0
# tests 0
# pass 0
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

    const parsed = parseTapStream(rawTap);
    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
    assert.ok(evaluation.failureReason?.includes("Zero tests were executed"));
  });

  await t.test("should reject malformed stream missing plan and summary", () => {
    const rawTap = `Running tests...
random console logs without TAP headers
ok 1 - something passed maybe
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, false);
    assert.ok(parsed.errors.some((e) => e.includes("Missing both TAP plan")));

    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
    assert.ok(evaluation.failureReason?.includes("Malformed or incomplete"));
  });

  await t.test("should reject stream with duplicate test IDs", () => {
    const rawTap = `TAP version 13
1..2
ok 1 - first test
ok 1 - duplicate first test
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, false);
    assert.ok(parsed.errors.some((e) => e.includes("Duplicate test ID")));

    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
  });

  await t.test("should reject stream with mathematical accounting discrepancy", () => {
    const rawTap = `TAP version 13
1..3
ok 1 - first test
ok 2 - second test
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
    // Only 2 points emitted, but summary says 3
    const parsed = parseTapStream(rawTap);
    assert.strictEqual(parsed.isWellFormed, false);
    assert.ok(parsed.errors.some((e) => e.includes("TAP accounting mismatch")));

    const evaluation = evaluateTapResult(parsed, 0);
    assert.strictEqual(evaluation.isPassed, false);
  });

  await t.test("should fail when exit code is non-zero even if output appears positive", () => {
    const rawTap = `TAP version 13
1..1
ok 1 - passed test
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
    const parsed = parseTapStream(rawTap);
    const evaluation = evaluateTapResult(parsed, 137); // Non-zero exit code (e.g. killed)
    assert.strictEqual(evaluation.isPassed, false);
    assert.ok(evaluation.failureReason?.includes("non-zero exit code: 137"));
  });
});
