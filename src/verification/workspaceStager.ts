import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import {
  PathValidationError,
  PathTraversalError,
  SecurityPolicyError,
  StagingLayoutError,
  StagingIntegrityError,
  CleanupTimeoutError,
} from "./types.js";
import { type ProposedChange } from "../changeGenerator.js";
import { simulateReplacement } from "../changeValidation.js";

/**
 * Permitted relative path patterns for file staging.
 */
export const STAGING_ALLOWLIST_PATTERNS = [
  "package.json",
  "tsconfig.json",
  "src/**/*.ts",
  "src/**/*.js",
  "tests/**/*.ts",
  "tests/**/*.js",
  "tests/fixtures/**/*",
];

/**
 * Prohibited relative path patterns never copied to staging.
 */
export const STAGING_DENYLIST_PREFIXES = [
  ".env",
  ".git",
  ".github",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".data",
  ".turbo",
];

export interface StagedWorkspace {
  stagingPath: string;
  targetFilePath: string;
  baselineHashes: Map<string, string>;
  isNoOp: boolean;
  cleanup: () => Promise<BoundedCleanupResult>;
}

export interface BoundedCleanupResult {
  cleanupStatus: "cleaned" | "failed";
  residualPath?: string;
  warning?: string;
  errorDetail?: string;
}

/**
 * Deferred cleanup ledger tracking uncleaned staging directories.
 */
export const PENDING_CLEANUP_SPOOL: Set<string> = new Set();

/**
 * Safely executes a bookkeeping or event recording action, ensuring neither synchronous
 * throws nor asynchronous rejections can escape to the unhandledRejection handler.
 */
export function safeRecordBookkeeping(action: () => void | Promise<void>): void {
  try {
    const result = action();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch(() => {
        // Safely swallow async bookkeeping failure
      });
    }
  } catch {
    // Safely swallow synchronous bookkeeping failure
  }
}

/**
 * Validates the full ancestry of a directory path up to the filesystem root drive.
 * Fails closed if any ancestor is a symlink or NTFS junction.
 */
export function validatePathAncestry(dirPath: string): void {
  const canonical = path.resolve(dirPath);
  let current = canonical;

  while (true) {
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(current);
    } catch (err: any) {
      throw new SecurityPolicyError(
        `Failed to inspect path ancestor "${current}": ${err.message}`
      );
    }

    if (lstat.isSymbolicLink()) {
      throw new SecurityPolicyError(
        `Symlink or junction detected and rejected in path ancestry: "${current}"`
      );
    }

    if (!lstat.isDirectory()) {
      throw new SecurityPolicyError(
        `Path ancestor is not a physical directory: "${current}"`
      );
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root (e.g. C:\ or /)
      break;
    }
    current = parent;
  }
}

/**
 * Helper to match relative paths against simple wildcard patterns (e.g. src/** /*.ts).
 */
export function matchStagingPattern(relPath: string, pattern: string): boolean {
  const posixRel = relPath.replace(/\\/g, "/");

  if (pattern === posixRel) {
    return true;
  }

  if (pattern.endsWith("/**/*")) {
    const prefix = pattern.slice(0, -5);
    return posixRel === prefix || posixRel.startsWith(prefix + "/");
  }

  if (pattern.endsWith("/**/*.ts")) {
    const prefix = pattern.slice(0, -8);
    return posixRel.startsWith(prefix + "/") && posixRel.endsWith(".ts");
  }

  if (pattern.endsWith("/**/*.js")) {
    const prefix = pattern.slice(0, -8);
    return posixRel.startsWith(prefix + "/") && posixRel.endsWith(".js");
  }

  return false;
}

/**
 * Validates target file path syntax, containment, allowlist, and ancestry.
 */
export function validateAndResolveTargetPath(
  stagingRoot: string,
  relativeTarget: string,
  allowlistPatterns: string[] = ["src/**/*.ts", "src/**/*.js"]
): string {
  if (!relativeTarget || typeof relativeTarget !== "string") {
    throw new PathValidationError("Target path must be a non-empty string");
  }

  // Reject Windows drive prefixes, backslashes, null bytes, and UNC prefixes
  if (
    relativeTarget.includes(":") ||
    relativeTarget.includes("\\") ||
    relativeTarget.includes("\0")
  ) {
    throw new PathValidationError(
      `Target path contains illegal characters, drive prefixes, or Windows backslashes: "${relativeTarget}"`
    );
  }

  if (relativeTarget.startsWith("//") || relativeTarget.startsWith("\\\\")) {
    throw new PathValidationError(
      `UNC or device namespace paths are strictly forbidden: "${relativeTarget}"`
    );
  }

  const normalized = path.posix.normalize(relativeTarget);
  if (
    normalized !== relativeTarget ||
    path.isAbsolute(relativeTarget) ||
    normalized.startsWith("..")
  ) {
    throw new PathTraversalError(
      `Target path must be a canonical, normalized relative path: "${relativeTarget}"`,
      relativeTarget,
      stagingRoot
    );
  }

  // 1. Validate canonical root and its ancestry
  const canonicalRoot = path.resolve(stagingRoot);
  validatePathAncestry(canonicalRoot);

  // 2. Relative containment check
  const resolvedTarget = path.resolve(canonicalRoot, relativeTarget);
  const rel = path.relative(canonicalRoot, resolvedTarget);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathTraversalError(
      `Target path escapes staging root: "${relativeTarget}"`,
      relativeTarget,
      stagingRoot
    );
  }

  // 3. Allowlist membership (Policy Check before filesystem inspection)
  const matchesAllowlist = allowlistPatterns.some((pattern) =>
    matchStagingPattern(normalized, pattern)
  );
  if (!matchesAllowlist) {
    throw new SecurityPolicyError(
      `Target file "${normalized}" is not within the permitted staging allowlist.`
    );
  }

  // 4. Segment-by-segment lstat inspection from canonicalRoot to target
  const segments = rel.split(path.sep);
  let currentPath = canonicalRoot;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    currentPath = path.join(currentPath, segment);

    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(currentPath);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new StagingLayoutError(
          `Staged layout incomplete: Required component does not exist in staging: "${currentPath}". Parent directory creation is forbidden.`
        );
      }
      throw err;
    }

    if (lstat.isSymbolicLink()) {
      throw new SecurityPolicyError(
        `Symlink or junction detected and rejected in target path segment: "${currentPath}"`
      );
    }

    const isFinalSegment = i === segments.length - 1;
    if (isFinalSegment) {
      if (!lstat.isFile()) {
        throw new SecurityPolicyError(
          `Target path is not a regular file: "${currentPath}"`
        );
      }
    } else {
      if (!lstat.isDirectory()) {
        throw new SecurityPolicyError(
          `Intermediate path segment is not a directory: "${currentPath}"`
        );
      }
    }
  }

  return resolvedTarget;
}

/**
 * Computes a map of relative file paths to SHA-256 hashes for all files in the staging directory.
 */
export function computeStagedTreeHashes(stagingDir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const canonicalRoot = path.resolve(stagingDir);

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        throw new SecurityPolicyError(
          `Symlink encountered during staged tree hashing: "${fullPath}"`
        );
      }

      if (lstat.isDirectory()) {
        walk(fullPath);
      } else if (lstat.isFile()) {
        const content = fs.readFileSync(fullPath);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        const relPath = path.relative(canonicalRoot, fullPath).replace(/\\/g, "/");
        hashes.set(relPath, hash);
      }
    }
  }

  walk(canonicalRoot);
  return hashes;
}

/**
 * Copies allowlisted files from the host repository into the staging workspace.
 */
export function copyAllowlistedFiles(repoRoot: string, stagingDir: string): void {
  const canonicalRepo = path.resolve(repoRoot);
  const canonicalStaging = path.resolve(stagingDir);

  function shouldDeny(relPosix: string): boolean {
    const parts = relPosix.split("/");
    const topPart = parts[0]!;

    for (const prefix of STAGING_DENYLIST_PREFIXES) {
      if (topPart === prefix || topPart.startsWith(prefix)) {
        return true;
      }
    }

    if (relPosix.endsWith(".pem") || relPosix.endsWith(".key") || relPosix.endsWith(".pfx")) {
      return true;
    }

    return false;
  }

  function shouldAllow(relPosix: string): boolean {
    return STAGING_ALLOWLIST_PATTERNS.some((pattern) =>
      matchStagingPattern(relPosix, pattern)
    );
  }

  function walkAndCopy(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(canonicalRepo, fullPath).replace(/\\/g, "/");

      if (shouldDeny(relPath)) {
        continue;
      }

      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        // Skip all symlinks
        continue;
      }

      if (lstat.isDirectory()) {
        walkAndCopy(fullPath);
      } else if (lstat.isFile()) {
        if (shouldAllow(relPath)) {
          const destPath = path.join(canonicalStaging, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(fullPath, destPath);
        }
      }
    }
  }

  walkAndCopy(canonicalRepo);
}

/**
 * Executes asynchronous bounded cleanup of the staging workspace.
 */
export async function executeBoundedStagingCleanup(
  stagingDir: string,
  timeoutMs: number = 3000
): Promise<BoundedCleanupResult> {
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  // 1. Launch background asynchronous removal operation
  const rmPromise = fsp.rm(stagingDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200,
  });

  // 2. Attach background settlement handlers guarded against BOTH sync and async errors
  rmPromise
    .then(() => {
      if (timedOut) {
        safeRecordBookkeeping(() => {
          PENDING_CLEANUP_SPOOL.delete(stagingDir);
        });
      }
    })
    .catch((err: any) => {
      if (timedOut) {
        safeRecordBookkeeping(() => {
          PENDING_CLEANUP_SPOOL.add(stagingDir);
        });
      }
    });

  // 3. Race against caller deadline with guaranteed timer clearance
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(
          new CleanupTimeoutError(`Asynchronous cleanup wait bounded at ${timeoutMs}ms`)
        );
      }, timeoutMs);
    });

    await Promise.race([rmPromise, timeoutPromise]);
    return { cleanupStatus: "cleaned" };
  } catch (err: any) {
    safeRecordBookkeeping(() => {
      PENDING_CLEANUP_SPOOL.add(stagingDir);
    });

    if (timedOut || err instanceof CleanupTimeoutError) {
      // Scenario A: Caller-wait deadline expired while fs.rm was still in progress
      return {
        cleanupStatus: "failed",
        residualPath: stagingDir,
        warning: `Warning: Staging directory cleanup wait timed out after ${timeoutMs}ms. Deletion may still be running in the background, or files may remain locked at: "${stagingDir}".`,
        errorDetail: err?.message,
      };
    } else {
      // Scenario B: Confirmed filesystem-removal error returned within the deadline
      return {
        cleanupStatus: "failed",
        residualPath: stagingDir,
        warning: `Warning: Staging directory removal failed with a confirmed filesystem error: ${err?.message ?? String(err)}. A residual directory remains at: "${stagingDir}".`,
        errorDetail: err?.message,
      };
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  }
}

/**
 * Creates an ephemeral staging workspace, copies allowlisted repository files,
 * validates the target file path, applies the simulated patch in-memory,
 * and asserts two-phase differential integrity.
 */
export async function stageWorkspace(
  repoRoot: string,
  proposal: ProposedChange,
  stagingBaseDir?: string | undefined
): Promise<StagedWorkspace> {
  // 1. Create a private ephemeral directory with random UUID
  const baseDir = stagingBaseDir || os.tmpdir();
  validatePathAncestry(baseDir);

  const stagingDirName = `repo-verify-${crypto.randomUUID()}`;
  const stagingPath = path.join(baseDir, stagingDirName);
  fs.mkdirSync(stagingPath, { recursive: true });

  const cleanupFn = async () => executeBoundedStagingCleanup(stagingPath);

  try {
    // 2. Copy allowlisted source & test files
    copyAllowlistedFiles(repoRoot, stagingPath);

    // 3. Validate target path syntax and containment
    const targetFilePath = validateAndResolveTargetPath(
      stagingPath,
      proposal.targetFile
    );

    // 4. Check for No-Op proposal before writing
    const currentOnDisk = fs.readFileSync(targetFilePath, "utf8");
    const simulation = simulateReplacement(
      currentOnDisk,
      proposal.startLine,
      proposal.endLine,
      proposal.proposedCode
    );

    const isNoOp =
      simulation.simulatedContent.trim() === currentOnDisk.trim() ||
      proposal.originalCode === proposal.proposedCode;

    // 5. Compute baseline SHA-256 tree hashes before patch write
    const baselineHashes = computeStagedTreeHashes(stagingPath);

    if (isNoOp) {
      return {
        stagingPath,
        targetFilePath,
        baselineHashes,
        isNoOp: true,
        cleanup: cleanupFn,
      };
    }

    // 6. Scoped write: Write simulated content strictly to the validated target file
    fs.writeFileSync(targetFilePath, simulation.simulatedContent, "utf8");

    // 7. Post-write re-validation sandwich: re-inspect target file with lstatSync
    const postStat = fs.lstatSync(targetFilePath);
    if (postStat.isSymbolicLink() || !postStat.isFile()) {
      throw new StagingIntegrityError(
        `Target path was compromised or replaced during write: "${targetFilePath}"`
      );
    }

    // 8. Compute post-patch hashes and assert differential tree integrity
    const postPatchHashes = computeStagedTreeHashes(stagingPath);
    const targetRelPosix = proposal.targetFile.replace(/\\/g, "/");

    if (postPatchHashes.size !== baselineHashes.size) {
      throw new StagingIntegrityError(
        `Staging tree integrity mismatch: file count changed from ${baselineHashes.size} to ${postPatchHashes.size}`
      );
    }

    for (const [file, hash] of postPatchHashes.entries()) {
      const baseHash = baselineHashes.get(file);
      if (!baseHash) {
        throw new StagingIntegrityError(
          `Unexpected new file introduced during patch staging: "${file}"`
        );
      }

      if (file === targetRelPosix) {
        if (hash === baseHash) {
          throw new StagingIntegrityError(
            `Target file hash did not change after writing patch: "${file}"`
          );
        }
      } else {
        if (hash !== baseHash) {
          throw new StagingIntegrityError(
            `Unexpected file modification outside target file: "${file}"`
          );
        }
      }
    }

    return {
      stagingPath,
      targetFilePath,
      baselineHashes,
      isNoOp: false,
      cleanup: cleanupFn,
    };
  } catch (err: any) {
    // If staging fails, ensure cleanup is initiated before re-throwing
    await cleanupFn();
    throw err;
  }
}
