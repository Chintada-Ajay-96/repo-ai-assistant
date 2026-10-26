import {
  type TestExecutionSummary,
  type SkippedTestDetail,
  type TodoTestDetail,
} from "./types.js";

export interface TapParsedPoint {
  id: number;
  status: "ok" | "not ok";
  description: string;
  directive?: "SKIP" | "TODO" | undefined;
  directiveReason?: string | undefined;
  isSuite?: boolean | undefined;
}

export interface TapParseResult {
  isWellFormed: boolean;
  planCount: number | null;
  summaryTotal: number | null;
  summaryPassed: number | null;
  summaryFailed: number | null;
  summaryCancelled: number | null;
  summarySkipped: number | null;
  summaryTodo: number | null;
  discretePassed: number;
  discreteFailed: number;
  discreteCancelled: number;
  discreteSkipped: number;
  discreteTodo: number;
  individualTests: TapParsedPoint[];
  skippedDetails: SkippedTestDetail[];
  todoDetails: TodoTestDetail[];
  errors: string[];
}

interface TapScope {
  indent: number;
  seenIds: Set<number>;
  planCount: number | null;
}

/**
 * Parses raw TAP v13 stdout streams emitted by Node.js test runner / tsx.
 */
export function parseTapStream(rawOutput: string): TapParseResult {
  const result: TapParseResult = {
    isWellFormed: false,
    planCount: null,
    summaryTotal: null,
    summaryPassed: null,
    summaryFailed: null,
    summaryCancelled: null,
    summarySkipped: null,
    summaryTodo: null,
    discretePassed: 0,
    discreteFailed: 0,
    discreteCancelled: 0,
    discreteSkipped: 0,
    discreteTodo: 0,
    individualTests: [],
    skippedDetails: [],
    todoDetails: [],
    errors: [],
  };

  const lines = rawOutput.split(/\r?\n/);
  const scopeStack: TapScope[] = [{ indent: 0, seenIds: new Set(), planCount: null }];
  let lastTestPoint: TapParsedPoint | null = null;

  // Patterns
  const planRegex = /^1\.\.(\d+)/;
  const testPointRegex = /^(ok|not ok)\s+(\d+)(?:\s+-\s+|\s+)?(.*?)(?:#\s*(SKIP|TODO)(?:[ :]+(.*))?)?$/i;
  const summaryTestsRegex = /^#\s+tests\s+(\d+)/i;
  const summaryPassRegex = /^#\s+pass\s+(\d+)/i;
  const summaryFailRegex = /^#\s+fail\s+(\d+)/i;
  const summaryCancelledRegex = /^#\s+cancelled\s+(\d+)/i;
  const summarySkippedRegex = /^#\s+skipped\s+(\d+)/i;
  const summaryTodoRegex = /^#\s+todo\s+(\d+)/i;

  let inYamlBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]!;
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    // Skip YAML diagnostic blocks (--- ... ...)
    if (line === "---") {
      inYamlBlock = true;
      continue;
    }
    if (inYamlBlock) {
      if (line === "...") {
        inYamlBlock = false;
      } else if (lastTestPoint && /^type:\s*['"]?suite['"]?/i.test(line)) {
        lastTestPoint.isSuite = true;
      }
      continue;
    }

    // Determine line indentation level
    const indentMatch = rawLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1]!.length : 0;

    // Adjust scope stack based on indentation
    if (indent > scopeStack[scopeStack.length - 1]!.indent) {
      scopeStack.push({ indent, seenIds: new Set(), planCount: null });
    } else {
      while (scopeStack.length > 1 && indent < scopeStack[scopeStack.length - 1]!.indent) {
        scopeStack.pop();
      }
    }
    const currentScope = scopeStack[scopeStack.length - 1]!;

    // Check Plan (1..N)
    const planMatch = line.match(planRegex);
    if (planMatch) {
      const count = parseInt(planMatch[1]!, 10);
      if (currentScope.planCount !== null && currentScope.planCount !== count) {
        result.errors.push(`Conflicting TAP plan declarations: ${currentScope.planCount} vs ${count}`);
      }
      currentScope.planCount = count;
      if (scopeStack.length === 1) {
        result.planCount = count;
      }
      continue;
    }

    // Check Summary Diagnostics
    const testsMatch = line.match(summaryTestsRegex);
    if (testsMatch) {
      result.summaryTotal = parseInt(testsMatch[1]!, 10);
      continue;
    }

    const passMatch = line.match(summaryPassRegex);
    if (passMatch) {
      result.summaryPassed = parseInt(passMatch[1]!, 10);
      continue;
    }

    const failMatch = line.match(summaryFailRegex);
    if (failMatch) {
      result.summaryFailed = parseInt(failMatch[1]!, 10);
      continue;
    }

    const cancelledMatch = line.match(summaryCancelledRegex);
    if (cancelledMatch) {
      result.summaryCancelled = parseInt(cancelledMatch[1]!, 10);
      continue;
    }

    const skippedMatch = line.match(summarySkippedRegex);
    if (skippedMatch) {
      result.summarySkipped = parseInt(skippedMatch[1]!, 10);
      continue;
    }

    const todoMatch = line.match(summaryTodoRegex);
    if (todoMatch) {
      result.summaryTodo = parseInt(todoMatch[1]!, 10);
      continue;
    }

    // Check Test Point Lines (ok / not ok)
    const pointMatch = line.match(testPointRegex);
    if (pointMatch) {
      const status = pointMatch[1]!.toLowerCase() as "ok" | "not ok";
      const id = parseInt(pointMatch[2]!, 10);
      const description = (pointMatch[3] ?? "").trim();
      const directiveRaw = pointMatch[4]?.toUpperCase();
      const directiveReason = pointMatch[5]?.trim();

      if (currentScope.seenIds.has(id)) {
        result.errors.push(`Duplicate test ID encountered in TAP stream: ${id}`);
      }
      currentScope.seenIds.add(id);

      const directive = directiveRaw === "SKIP" || directiveRaw === "TODO" ? directiveRaw : undefined;

      const testPoint: TapParsedPoint = {
        id,
        status,
        description,
        directive,
        directiveReason,
        isSuite: false,
      };
      result.individualTests.push(testPoint);
      lastTestPoint = testPoint;
    }
  }

  // Calculate discrete counters from non-suite individual test points
  for (const point of result.individualTests) {
    if (point.isSuite) {
      continue;
    }
    if (point.directive === "SKIP") {
      result.discreteSkipped++;
      result.skippedDetails.push({
        id: point.id,
        description: point.description,
        reason: point.directiveReason,
      });
    } else if (point.directive === "TODO") {
      result.discreteTodo++;
      result.todoDetails.push({
        id: point.id,
        description: point.description,
        passedUnexpectedly: point.status === "ok",
        reason: point.directiveReason,
      });
    } else {
      if (point.status === "ok") {
        result.discretePassed++;
      } else {
        result.discreteFailed++;
      }
    }
  }

  // --- Strict Validation & Reconciliation ---
  // A well-formed TAP stream requires a plan OR summary diagnostics
  const hasPlan = result.planCount !== null;
  const hasSummary = result.summaryTotal !== null;

  if (!hasPlan && !hasSummary) {
    result.errors.push("Missing both TAP plan (1..N) and summary diagnostics (# tests N). Stream may be incomplete or truncated.");
    result.isWellFormed = false;
    return result;
  }

  const expectedTotal = result.summaryTotal ?? result.planCount ?? 0;

  // Discrete count reconciliation
  const discreteTotal =
    result.discretePassed +
    result.discreteFailed +
    result.discreteCancelled +
    result.discreteSkipped +
    result.discreteTodo;

  if (expectedTotal !== discreteTotal) {
    result.errors.push(
      `TAP accounting mismatch: summary indicates ${expectedTotal} test(s), but discrete parsed points sum to ${discreteTotal}.`
    );
  }

  if (result.summaryPassed !== null && result.summaryPassed !== result.discretePassed) {
    result.errors.push(
      `TAP pass count mismatch: summary says ${result.summaryPassed}, but parsed ${result.discretePassed} active pass(es).`
    );
  }

  if (result.summaryFailed !== null && result.summaryFailed !== result.discreteFailed) {
    result.errors.push(
      `TAP fail count mismatch: summary says ${result.summaryFailed}, but parsed ${result.discreteFailed} fail(es).`
    );
  }

  if (result.summarySkipped !== null && result.summarySkipped !== result.discreteSkipped) {
    result.errors.push(
      `TAP skip count mismatch: summary says ${result.summarySkipped}, but parsed ${result.discreteSkipped} skip(s).`
    );
  }

  if (result.summaryTodo !== null && result.summaryTodo !== result.discreteTodo) {
    result.errors.push(
      `TAP todo count mismatch: summary says ${result.summaryTodo}, but parsed ${result.discreteTodo} todo(s).`
    );
  }

  result.isWellFormed = result.errors.length === 0;
  return result;
}

/**
 * Converts a parsed TAP result into a structured TestExecutionSummary and evaluates pass/fail status.
 */
export function evaluateTapResult(
  tapResult: TapParseResult,
  exitCode: number | null,
  suitesRan: string[] = []
): {
  isPassed: boolean;
  summary: TestExecutionSummary;
  failureReason?: string | undefined;
} {
  const summary: TestExecutionSummary = {
    suitesRan,
    totalReported: tapResult.summaryTotal ?? tapResult.planCount ?? tapResult.individualTests.length,
    passed: tapResult.discretePassed,
    failed: tapResult.discreteFailed,
    cancelled: tapResult.discreteCancelled,
    skipped: tapResult.discreteSkipped,
    todo: tapResult.discreteTodo,
    skippedDetails: tapResult.skippedDetails,
    todoDetails: tapResult.todoDetails,
  };

  // Stream well-formedness check
  if (!tapResult.isWellFormed) {
    return {
      isPassed: false,
      summary,
      failureReason: `Malformed or incomplete test output: ${tapResult.errors.join("; ")}`,
    };
  }

  // Any failures or cancellations
  if (summary.failed > 0) {
    return {
      isPassed: false,
      summary,
      failureReason: `${summary.failed} test assertion(s) failed against the proposed change.`,
    };
  }

  if (summary.cancelled > 0) {
    return {
      isPassed: false,
      summary,
      failureReason: `${summary.cancelled} test(s) were cancelled during execution.`,
    };
  }

  // Exit code check (e.g. runner crash, unhandled error outside tests, killed)
  if (exitCode !== 0) {
    return {
      isPassed: false,
      summary,
      failureReason: `Test runner exited with non-zero exit code: ${exitCode}`,
    };
  }

  // Zero active tests check
  if (summary.passed === 0) {
    if (summary.totalReported === 0) {
      return {
        isPassed: false,
        summary,
        failureReason: "Zero tests were executed. Test runner completed but found no active test cases.",
      };
    }

    if (summary.skipped > 0 && summary.passed === 0) {
      return {
        isPassed: false,
        summary,
        failureReason: `All ${summary.skipped} candidate test(s) were skipped. No assertions were verified against the proposed change.`,
      };
    }

    if (summary.todo > 0 && summary.passed === 0) {
      return {
        isPassed: false,
        summary,
        failureReason: `All ${summary.todo} test(s) were marked TODO. Zero active verified assertions executed.`,
      };
    }

    return {
      isPassed: false,
      summary,
      failureReason: "Zero test assertions passed against the proposed change.",
    };
  }


  // Passed strictly: passed >= 1, failed === 0, cancelled === 0
  return {
    isPassed: true,
    summary,
  };
}
