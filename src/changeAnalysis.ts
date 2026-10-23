import * as fs from "node:fs";
import * as path from "node:path";
import { extractSourceLines, type CodeChunk } from "./codeChunks.js";
import {
  retrieveRelevantCode,
  formatSingleChunkContext,
  formatScore,
  CONTEXT_SEPARATOR,
  type RetrievedChunk,
  type RetrieveOptions,
  type BuildContextOptions,
} from "./retrieval.js";
import { getChunkId } from "./vectorStore.js";
import { normalizePath } from "./utils/walkRepo.js";

/**
 * Default cosine-similarity threshold below which two competing top candidates
 * are considered ambiguous unless explicit hints are provided.
 */
export const DEFAULT_AMBIGUITY_THRESHOLD = 0.02;

/**
 * A verified code chunk targeted for change.
 */
export interface TargetCodeChunk {
  file: string;
  symbol: string;
  type: string;
  startLine: number;
  endLine: number;
  currentCode: string;
  language: string;
  parent?: string | undefined;
  score: number;
}

/**
 * Optional hints provided by the user or caller to guide target selection.
 */
export interface TargetHints {
  symbol?: string | undefined;
  file?: string | undefined;
}

/**
 * The structured result of change analysis.
 */
export interface ChangeContext {
  instruction: string;
  target: TargetCodeChunk;
  references: RetrievedChunk[];
  formattedContext: string;
}

/**
 * Options for configuring change analysis.
 */
export interface AnalyzeChangeOptions {
  hints?: TargetHints | undefined;
  targetSymbol?: string | undefined;
  targetFile?: string | undefined;
  topK?: number | undefined;
  retrieveOptions?: RetrieveOptions | undefined;
  contextOptions?: BuildContextOptions | undefined;
  ambiguityThreshold?: number | undefined;
  readFileFn?: ((filePath: string) => string) | undefined;
  repoRoot?: string | undefined;
  minScore?: number | undefined;
}

/**
 * Base error class for change analysis failures.
 */
export class ChangeAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeAnalysisError";
  }
}

/**
 * Thrown when vector retrieval returns no results or no results above minScore.
 */
export class EmptyRetrievalError extends ChangeAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "EmptyRetrievalError";
  }
}

/**
 * Thrown when target hints filter out all retrieved results.
 */
export class NoMatchingTargetError extends ChangeAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "NoMatchingTargetError";
  }
}

/**
 * Thrown when multiple candidate targets have close scores and cannot be disambiguated.
 */
export class AmbiguousTargetError extends ChangeAnalysisError {
  readonly candidates: RetrievedChunk[];

  constructor(message: string, candidates: RetrievedChunk[]) {
    super(message);
    this.name = "AmbiguousTargetError";
    this.candidates = candidates;
  }
}

/**
 * Thrown when the code or line boundaries on disk do not match the indexed chunk.
 */
export class StaleIndexError extends ChangeAnalysisError {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;

  constructor(message: string, file: string, startLine: number, endLine: number) {
    super(message);
    this.name = "StaleIndexError";
    this.file = file;
    this.startLine = startLine;
    this.endLine = endLine;
  }
}

/**
 * Thrown when the target file does not exist on disk.
 */
export class TargetFileNotFoundError extends ChangeAnalysisError {
  readonly file: string;

  constructor(message: string, file: string) {
    super(message);
    this.name = "TargetFileNotFoundError";
    this.file = file;
  }
}

/**
 * Thrown when reading the target file encounters an I/O error.
 */
export class FileReadError extends ChangeAnalysisError {
  readonly file: string;

  constructor(message: string, file: string) {
    super(message);
    this.name = "FileReadError";
    this.file = file;
  }
}

/**
 * Result structure returned by safeAnalyzeChangeTarget for callers avoiding try/catch.
 */
export type SafeChangeAnalysisResult =
  | { success: true; context: ChangeContext }
  | {
      success: false;
      error: ChangeAnalysisError;
      reason:
        | "empty_retrieval"
        | "ambiguous_target"
        | "no_matching_target"
        | "stale_index"
        | "file_not_found"
        | "file_read_error"
        | "invalid_instruction";
      candidates?: RetrievedChunk[] | undefined;
    };

/**
 * Tests whether a chunk's file path matches a file hint.
 */
function matchesFile(chunkFile: string, hintFile: string): boolean {
  const normChunk = normalizePath(chunkFile).toLowerCase();
  const normHint = normalizePath(hintFile).toLowerCase();
  return normChunk === normHint || normChunk.endsWith(`/${normHint}`);
}

/**
 * Tests whether a chunk's symbol name matches a symbol hint.
 */
function matchesSymbol(chunkSymbol: string, hintSymbol: string): boolean {
  return chunkSymbol.toLowerCase() === hintSymbol.toLowerCase();
}

/**
 * Formats structured change context separating change instruction,
 * verified target to modify, and reference context.
 */
export function formatChangeContext(
  instruction: string,
  target: TargetCodeChunk,
  references: RetrievedChunk[]
): string {
  const sections: string[] = [];

  sections.push("==================================================");
  sections.push("CHANGE INSTRUCTION");
  sections.push("==================================================");
  sections.push(instruction);
  sections.push("");

  sections.push("==================================================");
  sections.push("TARGET TO MODIFY");
  sections.push("==================================================");
  sections.push(`File: ${target.file}`);
  sections.push(`Symbol: ${target.symbol}`);
  sections.push(`Type: ${target.type}`);
  if (target.parent) {
    sections.push(`Parent: ${target.parent}`);
  }
  sections.push(`Lines: ${target.startLine}-${target.endLine}`);
  sections.push(`Language: ${target.language}`);
  sections.push(`Similarity: ${formatScore(target.score)}`);
  sections.push("");
  sections.push("Current Code:");
  sections.push(target.currentCode);
  sections.push("");

  if (references.length > 0) {
    sections.push("==================================================");
    sections.push("REFERENCE CONTEXT");
    sections.push("==================================================");
    for (const ref of references) {
      sections.push(CONTEXT_SEPARATOR);
      sections.push(formatSingleChunkContext(ref));
    }
    sections.push(CONTEXT_SEPARATOR);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

/**
 * Analyzes a developer change instruction, retrieves relevant code,
 * identifies and disambiguates the target code chunk, verifies the target against
 * the current file on disk, and builds structured change context.
 */
export async function analyzeChangeTarget(
  instruction: string,
  options?: AnalyzeChangeOptions
): Promise<ChangeContext> {
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw new ChangeAnalysisError("Change instruction cannot be empty.");
  }
  const trimmedInstruction = instruction.trim();

  // 1. Retrieve relevant code chunks
  const topK = options?.topK ?? options?.retrieveOptions?.topK ?? 10;
  const retrieval = await retrieveRelevantCode(trimmedInstruction, {
    ...options?.retrieveOptions,
    topK,
  });

  if (!retrieval.results || retrieval.results.length === 0) {
    throw new EmptyRetrievalError(
      `No relevant code chunks found in the repository for instruction: "${trimmedInstruction}".`
    );
  }

  let candidates = retrieval.results;

  // Filter by minScore if configured
  if (typeof options?.minScore === "number") {
    candidates = candidates.filter((c) => c.score >= options.minScore!);
    if (candidates.length === 0) {
      throw new EmptyRetrievalError(
        `No relevant code chunks met the minimum similarity score of ${options.minScore} for instruction: "${trimmedInstruction}".`
      );
    }
  }

  // 2. Resolve target hints
  const hintSymbol = options?.hints?.symbol ?? options?.targetSymbol;
  const hintFile = options?.hints?.file ?? options?.targetFile;

  let filtered = candidates;

  if (hintFile && hintFile.trim() !== "") {
    const trimmedFile = hintFile.trim();
    filtered = filtered.filter((c) => matchesFile(c.chunk.file, trimmedFile));
    if (filtered.length === 0) {
      throw new NoMatchingTargetError(
        `No retrieved code chunks matched the target file hint: "${trimmedFile}".`
      );
    }
  }

  if (hintSymbol && hintSymbol.trim() !== "") {
    const trimmedSymbol = hintSymbol.trim();
    filtered = filtered.filter((c) => matchesSymbol(c.chunk.symbol, trimmedSymbol));
    if (filtered.length === 0) {
      throw new NoMatchingTargetError(
        `No retrieved code chunks matched the target symbol hint: "${trimmedSymbol}".`
      );
    }
  }

  // 3. Ambiguity Detection
  const ambiguityThreshold = options?.ambiguityThreshold ?? DEFAULT_AMBIGUITY_THRESHOLD;

  if (filtered.length > 1) {
    const topCandidate = filtered[0]!;
    const secondCandidate = filtered[1]!;

    const scoreDiff = Math.abs(topCandidate.score - secondCandidate.score);

    // If both hints were specified and matched multiple, or if score difference is within ambiguity margin
    const isDifferentTarget =
      topCandidate.chunk.symbol !== secondCandidate.chunk.symbol ||
      topCandidate.chunk.file !== secondCandidate.chunk.file ||
      topCandidate.chunk.startLine !== secondCandidate.chunk.startLine;

    if (isDifferentTarget && scoreDiff <= ambiguityThreshold) {
      // Gather all competing candidates within ambiguity threshold of top score
      const competing = filtered.filter(
        (c) => Math.abs(topCandidate.score - c.score) <= ambiguityThreshold
      );

      const candidateList = competing
        .map(
          (c) =>
            `[${c.chunk.symbol} in ${c.chunk.file}:${c.chunk.startLine}-${c.chunk.endLine} (score: ${formatScore(c.score)})]`
        )
        .join(", ");

      throw new AmbiguousTargetError(
        `Ambiguous change target: multiple candidate symbols found with similar relevance (${candidateList}). Please provide a target symbol or file hint to disambiguate.`,
        competing
      );
    }
  }

  const targetChunk = filtered[0]!;

  // 4. Verify target chunk against current file on disk
  const rawFilePath = targetChunk.chunk.file;
  const filePath = options?.repoRoot
    ? path.resolve(options.repoRoot, rawFilePath)
    : rawFilePath;

  let fileContent: string;
  if (options?.readFileFn) {
    try {
      fileContent = options.readFileFn(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT") || msg.toLowerCase().includes("not found")) {
        throw new TargetFileNotFoundError(
          `Target file not found on disk: '${filePath}'. The file may have been moved or deleted. Please re-index the repository.`,
          filePath
        );
      }
      throw new FileReadError(
        `Failed to read target file '${filePath}': ${msg}`,
        filePath
      );
    }
  } else {
    if (!fs.existsSync(filePath)) {
      throw new TargetFileNotFoundError(
        `Target file not found on disk: '${filePath}'. The file may have been moved or deleted. Please re-index the repository.`,
        filePath
      );
    }
    try {
      fileContent = fs.readFileSync(filePath, "utf8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FileReadError(
        `Failed to read target file '${filePath}': ${msg}`,
        filePath
      );
    }
  }

  const startLine = targetChunk.chunk.startLine;
  const endLine = targetChunk.chunk.endLine;

  if (startLine < 1 || endLine < startLine) {
    throw new StaleIndexError(
      `Stale index detected for '${rawFilePath}'. Invalid line range ${startLine}-${endLine}. Please re-index the repository with 'npm run index'.`,
      rawFilePath,
      startLine,
      endLine
    );
  }

  const extractedCode = extractSourceLines(fileContent, startLine, endLine);
  if (extractedCode === null) {
    throw new StaleIndexError(
      `Stale index detected for '${rawFilePath}'. Lines ${startLine}-${endLine} are out of bounds for the current file on disk. Please re-index the repository with 'npm run index'.`,
      rawFilePath,
      startLine,
      endLine
    );
  }

  // Normalize line endings to avoid CRLF vs LF mismatches
  const normExtracted = extractedCode.replace(/\r\n/g, "\n").trim();
  const indexedCode = targetChunk.chunk.code ?? "";
  const normIndexed = indexedCode.replace(/\r\n/g, "\n").trim();

  if (normExtracted !== normIndexed) {
    throw new StaleIndexError(
      `Stale index detected for '${rawFilePath}' at lines ${startLine}-${endLine}. The current code on disk does not match the indexed code. Please re-index the repository with 'npm run index'.`,
      rawFilePath,
      startLine,
      endLine
    );
  }

  const verifiedTarget: TargetCodeChunk = {
    file: targetChunk.chunk.file,
    symbol: targetChunk.chunk.symbol,
    type: targetChunk.chunk.type,
    startLine: targetChunk.chunk.startLine,
    endLine: targetChunk.chunk.endLine,
    currentCode: extractedCode,
    language: targetChunk.chunk.language,
    parent: targetChunk.chunk.parent,
    score: targetChunk.score,
  };

  // 5. Gather reference chunks (excluding the target chunk and deduplicating)
  const targetId = getChunkId(targetChunk.chunk);
  const seenIds = new Set<string>([targetId]);
  const references: RetrievedChunk[] = [];

  for (const item of candidates) {
    const id = getChunkId(item.chunk);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      references.push(item);
    }
  }

  // 6. Build formatted context
  const formattedContext = formatChangeContext(
    trimmedInstruction,
    verifiedTarget,
    references
  );

  return {
    instruction: trimmedInstruction,
    target: verifiedTarget,
    references,
    formattedContext,
  };
}

/**
 * Safe wrapper around analyzeChangeTarget that returns a discriminated result object
 * instead of throwing exceptions.
 */
export async function safeAnalyzeChangeTarget(
  instruction: string,
  options?: AnalyzeChangeOptions
): Promise<SafeChangeAnalysisResult> {
  try {
    const context = await analyzeChangeTarget(instruction, options);
    return { success: true, context };
  } catch (err: unknown) {
    if (err instanceof AmbiguousTargetError) {
      return {
        success: false,
        error: err,
        reason: "ambiguous_target",
        candidates: err.candidates,
      };
    }
    if (err instanceof EmptyRetrievalError) {
      return {
        success: false,
        error: err,
        reason: "empty_retrieval",
      };
    }
    if (err instanceof NoMatchingTargetError) {
      return {
        success: false,
        error: err,
        reason: "no_matching_target",
      };
    }
    if (err instanceof StaleIndexError) {
      return {
        success: false,
        error: err,
        reason: "stale_index",
      };
    }
    if (err instanceof TargetFileNotFoundError) {
      return {
        success: false,
        error: err,
        reason: "file_not_found",
      };
    }
    if (err instanceof FileReadError) {
      return {
        success: false,
        error: err,
        reason: "file_read_error",
      };
    }
    if (err instanceof ChangeAnalysisError) {
      return {
        success: false,
        error: err,
        reason: "invalid_instruction",
      };
    }
    const genericError = new ChangeAnalysisError(
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: genericError,
      reason: "invalid_instruction",
    };
  }
}
