import { type ValidatedChangePlan } from "../changeValidation.js";
import { type ProposedChange } from "../changeGenerator.js";
import { type TestDiscoveryResult } from "../testDiscovery.js";

export type { ValidatedChangePlan, ProposedChange, TestDiscoveryResult };

/**
 * Deterministic verification outcome status.
 */
export type VerificationStatus =
  | "passed"                // >=1 tests passed, 0 failed, 0 cancelled, full accounting, clean termination & confirmed cleanup
  | "failed"                // Tests failed, 0 tests passed, all skipped, or no-op proposal
  | "timed_out"             // Exceeded timeout limit and container kill was initiated
  | "output_limit_exceeded" // Exceeded output byte limit and container kill was initiated
  | "unavailable"           // Docker pipe, verified image, permissions, or prerequisites missing
  | "error";                // Staging, path validation, TAP accounting, or unconfirmed cleanup error

/**
 * Cleanup outcome status on the host.
 */
export type CleanupStatus = "cleaned" | "failed" | "not_applicable";

/**
 * Supported execution environments.
 */
export type VerificationEnvironment = "docker" | "none";

/**
 * Detail for a single skipped test case.
 */
export interface SkippedTestDetail {
  id: number;
  description: string;
  reason?: string | undefined;
}

/**
 * Detail for a single TODO test case.
 */
export interface TodoTestDetail {
  id: number;
  description: string;
  passedUnexpectedly: boolean;
  reason?: string | undefined;
}

/**
 * Structured summary of test runner execution parsed from machine-readable TAP stream.
 */
export interface TestExecutionSummary {
  suitesRan: string[];
  totalReported: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  todo: number;
  skippedDetails: SkippedTestDetail[];
  todoDetails: TodoTestDetail[];
}

/**
 * Approved command structure permitted to run in the sandbox.
 */
export interface ApprovedTestCommand {
  runnerId: "tsx-node-test";
  executable: string;
  args: string[];
  targetTestFiles: string[];
}

/**
 * Strict verification execution resource limits.
 */
export interface VerificationLimits {
  /** Maximum wall-clock execution time in milliseconds (default: 30000). */
  timeoutMs: number;
  /** Maximum combined stdout/stderr output size in bytes (default: 524288 / 512KB). */
  maxOutputBytes: number;
  /** Container memory limit string (default: "1024m"). */
  memoryLimit: string;
  /** Container CPU core limit string (default: "1.0"). */
  cpuLimit: string;
  /** Process count ceiling (default: 64). */
  pidsLimit: number;
}

/**
 * Options passed to verifyProposedChange.
 */
export interface VerificationOptions {
  /** Custom resource limits (must be <= security ceilings). */
  limits?: Partial<VerificationLimits> | undefined;
  /** Base staging path (defaults to os.tmpdir()). */
  stagingBaseDir?: string | undefined;
  /** Test-only flag to simulate missing Docker runtime without touching Docker. */
  forceUnavailable?: boolean | undefined;
}

/**
 * Input request provided to verifyProposedChange.
 */
export interface VerificationRequest {
  /** Validated change plan from Phase 4. */
  validatedPlan: ValidatedChangePlan;
  /** Candidate tests discovered in Phase 5A. */
  testDiscovery: TestDiscoveryResult;
  /** Host repository root directory. */
  repoRoot: string;
  /** Optional verification configuration options. */
  options?: VerificationOptions | undefined;
}

/**
 * Detailed, structured verification result returned by verifyProposedChange.
 */
export interface VerificationResult {
  /** Verification status. */
  status: VerificationStatus;
  /** Active isolation boundary used. */
  environment: VerificationEnvironment;
  /** Process exit code (null if killed, timed out, or unavailable). */
  exitCode: number | null;
  /** Captured stdout stream (capped at maxOutputBytes). */
  stdout: string;
  /** Captured stderr stream (capped at maxOutputBytes). */
  stderr: string;
  /** True if output was truncated due to output limit. */
  outputTruncated: boolean;
  /** Wall-clock execution duration in milliseconds. */
  durationMs: number;
  /** The approved command executed inside the container. */
  command?: ApprovedTestCommand | undefined;
  /** Parsed execution summary. */
  executionSummary?: TestExecutionSummary | undefined;
  /** Ephemeral workspace cleanup outcome. */
  cleanupStatus: CleanupStatus;
  /** Human-readable failure or unavailability reason. */
  failureReason?: string | undefined;
  /** Non-fatal diagnostic warnings. */
  warnings: string[];
  /** Truthful security notice corresponding to the actual outcome. */
  securityNotice: string;
  /** Truthful semantic disclaimer corresponding to the actual outcome. */
  semanticDisclaimer: string;
}

/**
 * Default resource and execution limits.
 */
export const DEFAULT_VERIFICATION_LIMITS: VerificationLimits = {
  timeoutMs: 30000,
  maxOutputBytes: 524288, // 512 KB
  memoryLimit: "1024m",
  cpuLimit: "1.0",
  pidsLimit: 64,
};

/**
 * Standard disclaimer explicitly distinguishing verification from total correctness.
 */
export const VERIFICATION_SEMANTIC_DISCLAIMER =
  "Notice: Verification executed candidate tests within an isolated container. Passing tests demonstrate that existing test assertions succeeded against the patched code, but do not prove total semantic correctness, absence of regressions in untested areas, or complete system security.";

// --- Specific Error Classes ---

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export class PathValidationError extends VerificationError {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

export class PathTraversalError extends VerificationError {
  readonly targetPath: string;
  readonly basePath: string;

  constructor(message: string, targetPath: string, basePath: string) {
    super(message);
    this.name = "PathTraversalError";
    this.targetPath = targetPath;
    this.basePath = basePath;
  }
}

export class SecurityPolicyError extends VerificationError {
  constructor(message: string) {
    super(message);
    this.name = "SecurityPolicyError";
  }
}

export class StagingLayoutError extends VerificationError {
  constructor(message: string) {
    super(message);
    this.name = "StagingLayoutError";
  }
}

export class StagingIntegrityError extends VerificationError {
  constructor(message: string) {
    super(message);
    this.name = "StagingIntegrityError";
  }
}

export class CleanupTimeoutError extends VerificationError {
  constructor(message: string) {
    super(message);
    this.name = "CleanupTimeoutError";
  }
}

// --- Dynamic Notice Generators ---

export function generateSecurityNotice(
  status: VerificationStatus,
  cleanupStatus: CleanupStatus
): string {
  switch (status) {
    case "passed":
    case "failed":
      return `Security Notice: Verification was executed inside a hardened Docker container pinned by verified Image ID. Network was disabled (--network none), root filesystem was read-only, capabilities were dropped, and resource ceilings were enforced. The host repository was not modified.${
        cleanupStatus === "failed" ? " Warning: Staging directory deletion was blocked by a host file lock or timed out." : ""
      }`;

    case "timed_out":
      return "Security Notice: Test execution exceeded the wall-clock timeout and was killed via SIGKILL. Network was disabled. Host repository was not modified.";

    case "output_limit_exceeded":
      return "Security Notice: Test execution exceeded the output byte ceiling and was killed. Network was disabled. Host repository was not modified.";

    case "unavailable":
      return "Security Notice: Verification was refused because the required local Docker Desktop named pipe, verified image, or permissions were not available. Untrusted test execution on the host was refused.";

    case "error":
      return "Security Notice: Verification halted due to a validation, infrastructure, or unconfirmed cleanup error. No unisolated code was executed on the host.";
  }
}

export function generateSemanticDisclaimer(
  status: VerificationStatus,
  summary?: TestExecutionSummary
): string {
  switch (status) {
    case "passed":
      const skipNote = summary && summary.skipped > 0
        ? ` (${summary.skipped} test(s) were skipped and not verified)`
        : "";
      return `Notice: Passing candidate tests confirms that existing assertions in the tested suites succeeded against the proposed code${skipNote}. It does NOT guarantee complete functional correctness, absence of regressions in untested paths, or total system security.`;

    case "failed":
      return "Notice: Verification failed. The proposed change introduced test failures, runtime errors, or failed to execute active test assertions.";

    case "timed_out":
    case "output_limit_exceeded":
      return "Notice: Verification could not confirm correctness because the test process violated execution constraints and was terminated.";

    case "unavailable":
    case "error":
      return "Notice: Behavioral verification could not be executed or workspace cleanup could not be confirmed. Test pass/fail status is unknown or withheld.";
  }
}
