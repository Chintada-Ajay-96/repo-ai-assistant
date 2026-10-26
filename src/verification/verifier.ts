import {
  type VerificationRequest,
  type VerificationResult,
  type VerificationStatus,
  type CleanupStatus,
  type TestExecutionSummary,
  generateSecurityNotice,
  generateSemanticDisclaimer,
} from "./types.js";
import { VERIFICATION_IMAGE, isImageProvisioned } from "./imageConfig.js";
import { resolveApprovedTestCommand } from "./commandAllowlist.js";
import { stageWorkspace, type StagedWorkspace } from "./workspaceStager.js";
import { parseTapStream, evaluateTapResult } from "./tapParser.js";
import {
  type IDockerExecutor,
  LocalDockerExecutor,
  type ContainerRunResult,
} from "./dockerSandbox.js";

/**
 * Main orchestrator for isolated behavioral verification of a proposed code change.
 *
 * Implements strict defense-in-depth isolation in accordance with Revision 16:
 * - Fails closed if Docker, local named pipe, or pinned image are unavailable.
 * - Enforces zero-inheritance minimal environment and unified -H endpoint.
 * - Mounts only the controlled ephemeral staging directory.
 * - Detects and rejects no-op proposals.
 * - Reconciles machine-readable TAP v13 streams with discrete accounting.
 * - Enforces hard timeout and streaming output limits.
 * - Withholds passing status if workspace cleanup or container termination cannot be confirmed.
 * - Never modifies the real host repository.
 */
export async function verifyProposedChange(
  request: VerificationRequest,
  executor: IDockerExecutor = new LocalDockerExecutor()
): Promise<VerificationResult> {
  const warnings: string[] = [];

  // 1. Preflight Change Plan Validation
  if (!request.validatedPlan.isValid) {
    return buildEarlyResult({
      status: "error",
      failureReason: `Invalid change plan: Change validation failed (${request.validatedPlan.failureReason || "AST syntax or validation checks failed"}). Verification aborted.`,
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  // 2. Preflight Force-Unavailable Check (Test & Override Option)
  if (request.options?.forceUnavailable) {
    return buildEarlyResult({
      status: "unavailable",
      failureReason: "Isolated verification was refused because unavailable mode was explicitly forced.",
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  // 3. Preflight Docker Runtime Availability
  const availability = await executor.checkAvailability();
  if (!availability.available) {
    return buildEarlyResult({
      status: "unavailable",
      failureReason: availability.reason || "Docker virtualization runtime is not available.",
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  // 4. Preflight Image Provisioning & Local Image ID Verification
  if (!isImageProvisioned(VERIFICATION_IMAGE)) {
    return buildEarlyResult({
      status: "unavailable",
      failureReason: "Verification image is unprovisioned. The trusted verification image must be built and smoke-tested before verification can run.",
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  const imageCheck = await executor.inspectImageId(VERIFICATION_IMAGE.expectedImageId);
  if (!imageCheck.matches) {
    return buildEarlyResult({
      status: "unavailable",
      failureReason: imageCheck.reason || "Local verification image verification failed.",
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  // 5. Resolve Approved Command from Discovered Tests
  let approvedCommand;
  try {
    approvedCommand = resolveApprovedTestCommand(request.testDiscovery);
  } catch (err: any) {
    return buildEarlyResult({
      status: "failed",
      failureReason: `Candidate test resolution failed: ${err.message}`,
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  if (approvedCommand.targetTestFiles.length === 0) {
    return buildEarlyResult({
      status: "failed",
      failureReason: "Zero candidate test files were discovered for target file. Verification cannot proceed without tests.",
      cleanupStatus: "not_applicable",
      warnings,
    });
  }

  // 6. Ephemeral Workspace Staging & Target Scoping
  let staged: StagedWorkspace;
  try {
    staged = await stageWorkspace(
      request.repoRoot,
      request.validatedPlan.proposal,
      request.options?.stagingBaseDir
    );
  } catch (err: any) {
    return buildEarlyResult({
      status: "error",
      failureReason: `Workspace staging failed: ${err.message}`,
      cleanupStatus: "failed",
      warnings,
    });
  }

  // 7. No-Op Proposal Detection
  if (staged.isNoOp) {
    const cleanupOutcome = await staged.cleanup();
    return buildEarlyResult({
      status: "failed",
      failureReason: "No-op change detected: Proposed replacement is identical to existing code in target file. Verification was not run because no modifications were proposed.",
      cleanupStatus: cleanupOutcome.cleanupStatus,
      warnings: cleanupOutcome.warning ? [cleanupOutcome.warning] : [],
    });
  }

  // 8. Ephemeral Canary Mount Permission Probe
  const canaryProbe = await executor.runCanaryWriteProbe(
    staged.stagingPath,
    VERIFICATION_IMAGE.expectedImageId
  );

  if (!canaryProbe.success) {
    const cleanupOutcome = await staged.cleanup();
    return buildEarlyResult({
      status: "unavailable",
      failureReason: canaryProbe.reason || "Container workspace permission probe failed.",
      cleanupStatus: cleanupOutcome.cleanupStatus,
      warnings: cleanupOutcome.warning ? [cleanupOutcome.warning] : [],
    });
  }

  // 9. Hardened Container Execution
  let runResult: ContainerRunResult;
  try {
    runResult = await executor.executeTestRun({
      stagingPath: staged.stagingPath,
      imageId: VERIFICATION_IMAGE.expectedImageId,
      command: approvedCommand,
      limits: request.options?.limits,
    });
  } catch (err: any) {
    const cleanupOutcome = await staged.cleanup();
    return buildEarlyResult({
      status: "error",
      failureReason: `Unexpected error during container execution: ${err.message}`,
      cleanupStatus: cleanupOutcome.cleanupStatus,
      warnings: cleanupOutcome.warning ? [cleanupOutcome.warning] : [],
    });
  }

  if (runResult.warnings.length > 0) {
    warnings.push(...runResult.warnings);
  }

  // 10. Reconcile TAP Stream & Pass/Fail Status
  const tapParsed = parseTapStream(runResult.stdout);
  const evaluation = evaluateTapResult(
    tapParsed,
    runResult.exitCode,
    approvedCommand.targetTestFiles
  );

  let status: VerificationStatus;
  let failureReason: string | undefined;

  if (runResult.timedOut) {
    status = "timed_out";
    failureReason = `Test execution exceeded wall-clock timeout (${request.options?.limits?.timeoutMs ?? 30000}ms) and was terminated.`;
  } else if (runResult.outputLimitExceeded) {
    status = "output_limit_exceeded";
    failureReason = `Test execution produced runaway output exceeding limit (${request.options?.limits?.maxOutputBytes ?? 524288} bytes) and was terminated.`;
  } else if (evaluation.isPassed) {
    status = "passed";
  } else {
    status = "failed";
    failureReason = evaluation.failureReason || "Test execution failed assertions or exited non-zero.";
  }

  // 11. Bounded Asynchronous Cleanup
  const cleanupOutcome = await staged.cleanup();
  let cleanupStatus: CleanupStatus = cleanupOutcome.cleanupStatus;

  if (cleanupOutcome.warning) {
    warnings.push(cleanupOutcome.warning);
  }

  if (!runResult.containerStoppedConfirmed) {
    cleanupStatus = "failed";
  }

  // 12. Strict Status Withholding Invariant:
  // If cleanup or container termination could not be confirmed, passing status is withheld
  if (cleanupStatus === "failed" && status === "passed") {
    status = "error";
    failureReason =
      "Verification tests passed, but isolated workspace cleanup or container termination could not be confirmed. To prevent unmonitored residual state on the host, passing status was withheld.";
  }

  return {
    status,
    environment: "docker",
    exitCode: runResult.exitCode,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    outputTruncated: runResult.outputTruncated,
    durationMs: runResult.durationMs,
    command: approvedCommand,
    executionSummary: evaluation.summary,
    cleanupStatus,
    failureReason,
    warnings,
    securityNotice: generateSecurityNotice(status, cleanupStatus),
    semanticDisclaimer: generateSemanticDisclaimer(status, evaluation.summary),
  };
}

function buildEarlyResult(params: {
  status: VerificationStatus;
  failureReason: string;
  cleanupStatus: CleanupStatus;
  warnings: string[];
}): VerificationResult {
  return {
    status: params.status,
    environment: "none",
    exitCode: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    durationMs: 0,
    cleanupStatus: params.cleanupStatus,
    failureReason: params.failureReason,
    warnings: params.warnings,
    securityNotice: generateSecurityNotice(params.status, params.cleanupStatus),
    semanticDisclaimer: generateSemanticDisclaimer(params.status),
  };
}
