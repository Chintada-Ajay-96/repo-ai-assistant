import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath, IGNORE_DIRS } from "./utils/walkRepo.js";

/**
 * Supported source extensions for test discovery.
 */
export const TEST_FILE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

/**
 * Standard test directory names recognized across various project conventions.
 */
export const RECOGNIZED_TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "testing",
  "e2e",
  "test-e2e",
]);

/**
 * Extended ignore directory set including build caches and tooling artifacts.
 */
export const EXTENDED_IGNORE_DIRS = new Set([
  ...IGNORE_DIRS,
  ".turbo",
  ".next",
  "coverage",
  ".cache",
  "out",
  ".nyc_output",
]);

/**
 * Suffix pattern detecting test/spec markers before the file extension.
 * Matches: .test.ts, .spec.js, _test.ts, -test.jsx, .tests.tsx, etc.
 */
const TEST_FILENAME_PATTERN = /[._-](test|spec|tests)\.[a-zA-Z0-9]+$/i;

/**
 * Prefix pattern detecting test files starting with test_ (e.g. test_auth.py or test_auth.js).
 */
const TEST_PREFIX_PATTERN = /^tests?_[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i;

/**
 * Pattern matching fixture, mock, or helper paths to avoid misclassifying them as test suites.
 */
const FIXTURE_PATH_PATTERN = /(?:^|\/)(fixtures?|__fixtures__|__mocks__|test-fixtures)\//i;

/**
 * Confidence ranking score thresholds.
 * - High (>= 0.75): Strong correlation (stem match + co-location or symbol reference).
 * - Medium (0.40 - 0.74): Probable match (stem match in project test folder or directory proximity).
 * - Low (< 0.40): General or weak candidate without specific target correlation.
 */
export const CONFIDENCE_THRESHOLD_HIGH = 0.75;
export const CONFIDENCE_THRESHOLD_LIKELY = 0.4;

/**
 * Typed candidate test discovered by the engine.
 */
export interface DiscoveredCandidateTest {
  filePath: string;
  absolutePath: string;
  confidence: number;
  confidenceTier: "high" | "medium" | "low";
  matchReasons: string[];
}

/**
 * Information regarding detected test runner frameworks.
 */
export interface TestRunnerHint {
  runner:
    | "node-test"
    | "jest"
    | "vitest"
    | "mocha"
    | "playwright"
    | "cypress"
    | "ava"
    | "unknown";
  source: "package_scripts" | "dependencies" | "config_file";
  details: string;
}

/**
 * Structured, typed result returned by test discovery.
 */
export interface TestDiscoveryResult {
  repoRoot: string;
  targetFile: string;
  targetSymbol?: string | undefined;
  targetFileExists: boolean;
  targetFileReadable: boolean;
  hasLikelyTests: boolean;
  tests: DiscoveredCandidateTest[];
  runnerHints: TestRunnerHint[];
  packageTestScripts: Record<string, string>;
  totalTestFilesScanned: number;
  warnings: string[];
}

/**
 * Options for configuring test discovery.
 */
export interface DiscoverTestsOptions {
  repoRoot: string;
  targetFile: string;
  targetSymbol?: string | undefined;
  customIgnoreDirs?: Set<string> | undefined;
  maxCandidates?: number | undefined;
  readTestContent?: boolean | undefined;
}

/**
 * Base error class for test discovery failures.
 */
export class TestDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDiscoveryError";
  }
}

/**
 * Thrown when target file or requested path escapes the repository root.
 */
export class PathTraversalError extends TestDiscoveryError {
  readonly targetPath: string;
  readonly repoRoot: string;

  constructor(message: string, targetPath: string, repoRoot: string) {
    super(message);
    this.name = "PathTraversalError";
    this.targetPath = targetPath;
    this.repoRoot = repoRoot;
  }
}

/**
 * Validates that a requested file path resolves strictly inside the repository root.
 * Throws PathTraversalError if the path attempts to escape or points outside.
 */
export function validatePathInsideRoot(filePath: string, rootDir: string): string {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TestDiscoveryError("Target file path cannot be empty.");
  }

  const resolvedRoot = path.resolve(rootDir);
  if (!fs.existsSync(resolvedRoot)) {
    throw new TestDiscoveryError(
      `Repository root does not exist: '${rootDir}'`
    );
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(resolvedRoot);
  } catch (err: unknown) {
    throw new TestDiscoveryError(
      `Failed to inspect repository root '${rootDir}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!rootStat.isDirectory()) {
    throw new TestDiscoveryError(
      `Repository root is not a directory: '${rootDir}'`
    );
  }

  const resolvedTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedRoot, filePath);

  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathTraversalError(
      `Target file path '${filePath}' escapes repository root '${rootDir}'. Traversal outside repository root is forbidden.`,
      filePath,
      rootDir
    );
  }

  // Verify that if target exists, its canonical realpath does not escape repository root via symlink
  if (fs.existsSync(resolvedTarget)) {
    try {
      const realRoot = fs.realpathSync(resolvedRoot);
      const realTarget = fs.realpathSync(resolvedTarget);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new PathTraversalError(
          `Target file path '${filePath}' resolves via symbolic link outside repository root '${rootDir}'. Traversal outside repository root is forbidden.`,
          filePath,
          rootDir
        );
      }
    } catch (err: unknown) {
      if (err instanceof PathTraversalError) {
        throw err;
      }
    }
  }

  return resolvedTarget;
}

/**
 * Extracts a base stem from a filename by stripping extension and any test/spec suffixes.
 * Example: 'auth.test.ts' -> 'auth', 'walkRepo.spec.js' -> 'walkRepo', 'math.js' -> 'math'.
 */
export function extractCleanStem(fileNameOrPath: string): string {
  const base = path.basename(fileNameOrPath);
  const ext = path.extname(base);
  const withoutExt = ext ? base.slice(0, -ext.length) : base;

  // Strip test/spec/tests suffix if present
  const cleaned = withoutExt.replace(/[._-](test|spec|tests)$/i, "");
  // Strip test_ prefix if present
  return cleaned.replace(/^tests?_/i, "");
}

/**
 * Evaluates whether a relative path represents a test file candidate.
 */
export function isTestFilePath(normalizedRelPath: string): boolean {
  const ext = path.extname(normalizedRelPath).toLowerCase();
  if (!TEST_FILE_EXTENSIONS.has(ext)) {
    return false;
  }

  const base = path.basename(normalizedRelPath);

  // Files in fixture/mock folders are ignored unless explicitly named as a test file
  if (FIXTURE_PATH_PATTERN.test(normalizedRelPath)) {
    return TEST_FILENAME_PATTERN.test(base) || TEST_PREFIX_PATTERN.test(base);
  }

  // 1. Filename matches test or spec pattern (*.test.ts, *_spec.js, test_*.js)
  if (TEST_FILENAME_PATTERN.test(base) || TEST_PREFIX_PATTERN.test(base)) {
    return true;
  }

  // 2. Exact test filename (e.g. test.js, tests.ts)
  const stem = path.basename(base, ext).toLowerCase();
  if (stem === "test" || stem === "tests") {
    return true;
  }

  // 3. Located inside recognized test directory segments (e.g. tests/unit/auth.ts)
  const segments = normalizedRelPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]?.toLowerCase();
    if (seg && RECOGNIZED_TEST_DIRS.has(seg)) {
      return true;
    }
  }

  return false;
}

/**
 * Traverses repository files starting at repoRoot, discovering candidate test files without escaping root.
 */
export function scanRepositoryForTests(
  repoRoot: string,
  ignoreDirs: Set<string> = EXTENDED_IGNORE_DIRS,
  warnings: string[] = []
): string[] {
  const discovered: string[] = [];
  const resolvedRoot = path.resolve(repoRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  const visitedDirs = new Set<string>([realRoot]);

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: unknown) {
      warnings.push(
        `Could not read directory '${normalizePath(path.relative(resolvedRoot, currentDir))}': ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      // Verify lexical path has not escaped root
      const relToRoot = path.relative(resolvedRoot, fullPath);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        continue;
      }

      // Handle symlinks safely: verify realpath containment to prevent escaping root
      if (entry.isSymbolicLink()) {
        try {
          const realEntryPath = fs.realpathSync(fullPath);
          const realRel = path.relative(realRoot, realEntryPath);
          if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
            // Symlink points outside repoRoot - safely ignore to prevent directory traversal
            continue;
          }
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (!ignoreDirs.has(entry.name) && !visitedDirs.has(realEntryPath)) {
              visitedDirs.add(realEntryPath);
              walk(fullPath);
            }
          } else if (stat.isFile()) {
            const normRel = normalizePath(relToRoot);
            if (isTestFilePath(normRel)) {
              discovered.push(normRel);
            }
          }
        } catch {
          // Broken symlink or inaccessible target - skip safely
          continue;
        }
      } else if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const normRel = normalizePath(relToRoot);
        if (isTestFilePath(normRel)) {
          discovered.push(normRel);
        }
      }
    }
  }

  walk(resolvedRoot);
  return discovered;
}

/**
 * Safely parses package.json as data to extract test scripts and detect runner hints.
 * NEVER executes npm, node, a shell, or any script commands.
 */
export function inspectPackageJson(
  repoRoot: string,
  warnings: string[] = []
): { runnerHints: TestRunnerHint[]; packageTestScripts: Record<string, string> } {
  const pkgPath = path.join(repoRoot, "package.json");
  const runnerHints: TestRunnerHint[] = [];
  const packageTestScripts: Record<string, string> = {};
  const seenRunners = new Set<string>();

  function addHint(
    runner: TestRunnerHint["runner"],
    source: TestRunnerHint["source"],
    details: string
  ) {
    if (!seenRunners.has(runner)) {
      seenRunners.add(runner);
      runnerHints.push({ runner, source, details });
    }
  }

  // 1. Inspect package.json if present
  if (fs.existsSync(pkgPath)) {
    let pkg: Record<string, unknown> | null = null;
    try {
      const raw = fs.readFileSync(pkgPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push("package.json is not a valid JSON object.");
      } else {
        pkg = parsed as Record<string, unknown>;
      }
    } catch (err: unknown) {
      warnings.push(
        `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (pkg) {
      // 1a. Extract test-related package scripts purely as passive data
      if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
        for (const [key, val] of Object.entries(pkg.scripts as Record<string, unknown>)) {
          if (typeof val === "string") {
            if (/test|spec|check/i.test(key)) {
              packageTestScripts[key] = val;
            }
          }
        }
      }

      // 1b. Collect dependencies for passive runner hint detection
      const allDeps: Record<string, string> = {};
      if (pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)) {
        Object.assign(allDeps, pkg.dependencies);
      }
      if (pkg.devDependencies && typeof pkg.devDependencies === "object" && !Array.isArray(pkg.devDependencies)) {
        Object.assign(allDeps, pkg.devDependencies);
      }

      // Passive runner detection from scripts
      const testScript = packageTestScripts["test"] ?? "";
      if (testScript.includes("tsx --test") || testScript.includes("node --test")) {
        addHint("node-test", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("jest")) {
        addHint("jest", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("vitest")) {
        addHint("vitest", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("mocha")) {
        addHint("mocha", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("playwright")) {
        addHint("playwright", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("cypress")) {
        addHint("cypress", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }
      if (testScript.includes("ava")) {
        addHint("ava", "package_scripts", `Found in scripts.test: "${testScript}"`);
      }

      // Passive runner detection from dependencies
      if (allDeps["jest"]) {
        addHint("jest", "dependencies", `Found 'jest' in project dependencies`);
      }
      if (allDeps["vitest"]) {
        addHint("vitest", "dependencies", `Found 'vitest' in project dependencies`);
      }
      if (allDeps["mocha"]) {
        addHint("mocha", "dependencies", `Found 'mocha' in project dependencies`);
      }
      if (allDeps["@playwright/test"]) {
        addHint("playwright", "dependencies", `Found '@playwright/test' in project dependencies`);
      }
      if (allDeps["cypress"]) {
        addHint("cypress", "dependencies", `Found 'cypress' in project dependencies`);
      }
      if (allDeps["ava"]) {
        addHint("ava", "dependencies", `Found 'ava' in project dependencies`);
      }
    }
  }

  // Passive runner detection from config files on disk
  const configChecks: Array<{ file: string; runner: TestRunnerHint["runner"] }> = [
    { file: "jest.config.js", runner: "jest" },
    { file: "jest.config.ts", runner: "jest" },
    { file: "jest.config.json", runner: "jest" },
    { file: "vitest.config.ts", runner: "vitest" },
    { file: "vitest.config.js", runner: "vitest" },
    { file: ".mocharc.json", runner: "mocha" },
    { file: ".mocharc.js", runner: "mocha" },
    { file: "playwright.config.ts", runner: "playwright" },
    { file: "playwright.config.js", runner: "playwright" },
    { file: "cypress.config.ts", runner: "cypress" },
    { file: "cypress.config.js", runner: "cypress" },
  ];

  for (const check of configChecks) {
    if (fs.existsSync(path.join(repoRoot, check.file))) {
      addHint(check.runner, "config_file", `Found configuration file '${check.file}'`);
    }
  }

  return { runnerHints, packageTestScripts };
}

/**
 * Checks whether target directory and test directory share a mirrored path structure.
 * E.g., target 'src/services/auth' and test 'tests/services/auth' -> both share 'services/auth'.
 */
function isMirroredSubdirectory(targetDir: string, testDir: string): boolean {
  if (!targetDir || !testDir) {
    return false;
  }

  // Strip leading source folders (src, lib, app)
  const normTarget = targetDir.replace(/^(?:src|lib|app)(?:\/|$)/i, "");
  // Strip leading test folders (test, tests, spec, specs)
  const normTest = testDir.replace(/^(?:tests?|specs?)(?:\/|$)/i, "");

  if (normTarget === "" || normTest === "") {
    return false;
  }

  return normTarget.toLowerCase() === normTest.toLowerCase();
}

/**
 * Evaluates whether a directory name is a recognized test folder.
 */
function isRecognizedTestDir(dirPath: string): boolean {
  if (!dirPath) {
    return false;
  }
  const segments = dirPath.split("/");
  return segments.some((s) => RECOGNIZED_TEST_DIRS.has(s.toLowerCase()));
}

/**
 * Computes confidence score and match reasons for a candidate test file.
 */
export function scoreCandidateTest(
  candidateRelPath: string,
  targetRelPath: string,
  targetCleanStem: string,
  targetSymbol?: string | undefined,
  symbolFound: boolean = false
): { confidence: number; confidenceTier: "high" | "medium" | "low"; matchReasons: string[] } {
  let score = 0.0;
  const matchReasons: string[] = [];

  const candidateCleanStem = extractCleanStem(candidateRelPath);
  const targetDir = normalizePath(path.dirname(targetRelPath));
  const candidateDir = normalizePath(path.dirname(candidateRelPath));

  const normTargetDir = targetDir === "." ? "" : targetDir;
  const normCandidateDir = candidateDir === "." ? "" : candidateDir;

  // 1. Stem matching (+0.50 exact, +0.20 partial)
  if (candidateCleanStem.toLowerCase() === targetCleanStem.toLowerCase()) {
    score += 0.5;
    matchReasons.push(`Exact filename stem match ('${targetCleanStem}')`);
  } else if (
    targetCleanStem.length >= 3 &&
    (candidateCleanStem.toLowerCase().includes(targetCleanStem.toLowerCase()) ||
      targetCleanStem.toLowerCase().includes(candidateCleanStem.toLowerCase()))
  ) {
    score += 0.2;
    matchReasons.push(
      `Partial filename stem match ('${candidateCleanStem}' ~ '${targetCleanStem}')`
    );
  }

  // 2. Directory proximity & structural matching
  if (normTargetDir && normCandidateDir === normTargetDir) {
    score += 0.25;
    matchReasons.push(`Co-located in target directory ('${normTargetDir}')`);
  } else if (
    normCandidateDir === `${normTargetDir}/__tests__` ||
    normCandidateDir === `${normTargetDir}/tests` ||
    normCandidateDir === `${normTargetDir}/test`
  ) {
    score += 0.2;
    matchReasons.push(
      `Located in test subfolder under target directory ('${normCandidateDir}')`
    );
  } else if (isMirroredSubdirectory(normTargetDir, normCandidateDir)) {
    score += 0.2;
    matchReasons.push(
      `Mirrors target directory structure inside test folder ('${normCandidateDir}')`
    );
  } else if (isRecognizedTestDir(normCandidateDir)) {
    score += 0.1;
    matchReasons.push(`Located in recognized test directory ('${normCandidateDir}')`);
  }

  // 3. Symbol reference in test content (+0.25)
  if (symbolFound && targetSymbol) {
    score += 0.25;
    matchReasons.push(
      `Symbol '${targetSymbol}' explicitly referenced in test file content`
    );
  }

  // Strictly normalize and clamp score between 0.00 and 1.00, rounded to 2 decimal places
  const finalConfidence = Math.max(0.0, Math.min(1.0, Math.round(score * 100) / 100));

  let confidenceTier: "high" | "medium" | "low";
  if (finalConfidence >= CONFIDENCE_THRESHOLD_HIGH) {
    confidenceTier = "high";
  } else if (finalConfidence >= CONFIDENCE_THRESHOLD_LIKELY) {
    confidenceTier = "medium";
  } else {
    confidenceTier = "low";
  }

  return {
    confidence: finalConfidence,
    confidenceTier,
    matchReasons,
  };
}

/**
 * Searches for explicit symbol mention inside a test file safely.
 * Bounded to 512 KB to avoid excessive memory consumption.
 */
function testContainsSymbol(absPath: string, symbol: string): boolean {
  if (!symbol || symbol.trim() === "") {
    return false;
  }

  try {
    const stat = fs.statSync(absPath);
    // Safety guard: skip files larger than 512 KB
    if (stat.size > 512 * 1024) {
      return false;
    }

    const content = fs.readFileSync(absPath, "utf8");
    // Escape regex special characters in symbol
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`);
    return regex.test(content);
  } catch {
    return false;
  }
}

/**
 * Synchronous core test discovery implementation.
 */
export function discoverTestsSync(options: DiscoverTestsOptions): TestDiscoveryResult {
  const { repoRoot, targetFile, targetSymbol, customIgnoreDirs, maxCandidates, readTestContent } =
    options;

  const warnings: string[] = [];

  // 1. Validate paths and ensure no root escape
  const resolvedTarget = validatePathInsideRoot(targetFile, repoRoot);
  const resolvedRoot = path.resolve(repoRoot);
  const targetRelPath = normalizePath(path.relative(resolvedRoot, resolvedTarget));

  // 2. Inspect target file status on disk
  let targetFileExists = false;
  let targetFileReadable = false;

  if (fs.existsSync(resolvedTarget)) {
    targetFileExists = true;
    try {
      fs.accessSync(resolvedTarget, fs.constants.R_OK);
      targetFileReadable = true;
    } catch {
      targetFileReadable = false;
      warnings.push(`Target file '${targetRelPath}' exists but is not readable.`);
    }
  } else {
    warnings.push(`Target file '${targetRelPath}' does not exist on disk.`);
  }

  // 3. Inspect package.json configuration passively
  const { runnerHints, packageTestScripts } = inspectPackageJson(resolvedRoot, warnings);

  // 4. Scan repository for all candidate test files
  const ignoreSet = customIgnoreDirs ?? EXTENDED_IGNORE_DIRS;
  const testFiles = scanRepositoryForTests(resolvedRoot, ignoreSet, warnings);

  // 5. Score candidate test files against target file and optional symbol
  const targetCleanStem = extractCleanStem(targetRelPath);
  const shouldReadContent = readTestContent ?? true;

  const candidateResults: DiscoveredCandidateTest[] = [];

  for (const testRel of testFiles) {
    const absTestPath = path.join(resolvedRoot, testRel);

    let symbolFound = false;
    if (targetSymbol && shouldReadContent) {
      symbolFound = testContainsSymbol(absTestPath, targetSymbol);
    }

    const scored = scoreCandidateTest(
      testRel,
      targetRelPath,
      targetCleanStem,
      targetSymbol,
      symbolFound
    );

    // Only include candidate tests with at least one match reason
    if (scored.matchReasons.length > 0) {
      candidateResults.push({
        filePath: testRel,
        absolutePath: absTestPath,
        confidence: scored.confidence,
        confidenceTier: scored.confidenceTier,
        matchReasons: scored.matchReasons,
      });
    }
  }

  // 6. Sort deterministically:
  //    1. Confidence score descending
  //    2. Exact stem match flag descending
  //    3. Match reasons count descending
  //    4. File path ascending (alphabetical tie-breaker)
  candidateResults.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    const aStem = a.matchReasons.some((r) => r.includes("Exact filename stem match"));
    const bStem = b.matchReasons.some((r) => r.includes("Exact filename stem match"));
    if (aStem !== bStem) {
      return aStem ? -1 : 1;
    }
    if (b.matchReasons.length !== a.matchReasons.length) {
      return b.matchReasons.length - a.matchReasons.length;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  const cappedCandidates =
    typeof maxCandidates === "number" && maxCandidates > 0
      ? candidateResults.slice(0, maxCandidates)
      : candidateResults;

  const hasLikelyTests = cappedCandidates.some(
    (t) => t.confidence >= CONFIDENCE_THRESHOLD_LIKELY
  );

  return {
    repoRoot: resolvedRoot,
    targetFile: targetRelPath,
    targetSymbol: targetSymbol && targetSymbol.trim() !== "" ? targetSymbol.trim() : undefined,
    targetFileExists,
    targetFileReadable,
    hasLikelyTests,
    tests: cappedCandidates,
    runnerHints,
    packageTestScripts,
    totalTestFilesScanned: testFiles.length,
    warnings,
  };
}

/**
 * Discovers candidate tests related to a target file or symbol.
 */
export async function discoverTests(
  options: DiscoverTestsOptions
): Promise<TestDiscoveryResult> {
  return discoverTestsSync(options);
}
