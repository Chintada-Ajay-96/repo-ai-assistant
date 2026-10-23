import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type ProposedChange } from "./changeGenerator.js";
import { treeSitterService } from "./repoMap.js";
import { extractSourceLines } from "./codeChunks.js";
import { getFileLanguageInfo, normalizePath } from "./utils/walkRepo.js";

/**
 * Standard disclaimer distinguishing syntactic validation from semantic correctness.
 */
export const SYNTAX_VALIDATION_DISCLAIMER =
  "Notice: Syntax validation confirms grammatical validity with Tree-sitter AST, but does not guarantee semantic correctness, runtime behavior, or type safety.";

/**
 * An individual validation check and its result.
 */
export interface ValidationCheck {
  id:
    | "file_exists"
    | "line_range_valid"
    | "source_match"
    | "language_supported"
    | "syntax_valid";
  name: string;
  passed: boolean;
  message: string;
  details?: string | undefined;
}

/**
 * Detailed syntax error information returned by Tree-sitter AST inspection.
 */
export interface SyntaxErrorDetail {
  line: number;
  column: number;
  message: string;
}

/**
 * The typed result of change validation.
 */
export interface ValidatedChangePlan {
  isValid: boolean;
  proposal: ProposedChange;
  checks: ValidationCheck[];
  simulatedContent?: string | undefined;
  preview: string;
  failureReason?: string | undefined;
  syntaxNotice: string;
}

/**
 * Configuration options for change validation.
 */
export interface ValidateChangeOptions {
  readFileFn?: ((filePath: string) => string) | undefined;
  repoRoot?: string | undefined;
}

/**
 * Simulates applying a proposed code replacement to the source lines entirely in memory.
 * Preserves all source lines before the target startLine and after the target endLine.
 */
export function simulateReplacement(
  currentSource: string,
  startLine: number,
  endLine: number,
  proposedCode: string
): {
  simulatedContent: string;
  beforeLines: string[];
  afterLines: string[];
  proposedLines: string[];
} {
  const fileLines = currentSource.split(/\r?\n/);
  const beforeLines = fileLines.slice(0, Math.max(0, startLine - 1));
  const afterLines = fileLines.slice(endLine);

  const normalizedProp = proposedCode.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const proposedLines = normalizedProp.length > 0 ? normalizedProp.split("\n") : [];

  const simulatedLines = [...beforeLines, ...proposedLines, ...afterLines];

  return {
    simulatedContent: simulatedLines.join("\n"),
    beforeLines,
    afterLines,
    proposedLines,
  };
}

/**
 * Extracts syntax errors from a parsed Tree-sitter root node.
 */
export function extractTreeSitterErrors(rootNode: Parser.SyntaxNode): SyntaxErrorDetail[] {
  const errors: SyntaxErrorDetail[] = [];
  if (!rootNode.hasError) {
    return errors;
  }

  try {
    const errorNodes = rootNode.descendantsOfType("ERROR");
    for (const node of errorNodes) {
      const line = node.startPosition.row + 1;
      const column = node.startPosition.column + 1;
      const snippet = node.text.replace(/\r?\n/g, " ").trim();
      const preview = snippet.length > 40 ? `${snippet.slice(0, 37)}...` : snippet;
      errors.push({
        line,
        column,
        message: preview
          ? `Syntax error near '${preview}' at line ${line}, column ${column}`
          : `Syntax error at line ${line}, column ${column}`,
      });
    }
  } catch {
    // If descendantsOfType encounters an issue, fallback to traversal
  }

  if (errors.length === 0) {
    function search(node: Parser.SyntaxNode) {
      if (node.isError || node.isMissing) {
        errors.push({
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          message: node.isMissing
            ? `Missing expected syntax token '${node.type}' at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`
            : `Syntax error at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}`,
        });
        return;
      }
      for (const child of node.children) {
        search(child);
      }
    }
    search(rootNode);
  }

  if (errors.length === 0 && rootNode.hasError) {
    errors.push({
      line: 1,
      column: 1,
      message: "Syntax error detected in parsed source.",
    });
  }

  return errors;
}

/**
 * Formats a comprehensive terminal/markdown preview of the validated change plan.
 */
export function formatDryRunPreview(
  proposal: ProposedChange,
  checks: ValidationCheck[],
  isValid: boolean,
  failureReason?: string
): string {
  const lines: string[] = [];

  lines.push("==================================================");
  lines.push("CHANGE VALIDATION REPORT");
  lines.push("==================================================");
  lines.push(`Target: ${proposal.file} :: ${proposal.symbol} (lines ${proposal.startLine}-${proposal.endLine})`);
  lines.push(`Status: ${isValid ? "PASSED (Ready for review)" : "FAILED"}`);
  lines.push("");

  lines.push("CHECKLIST:");
  for (const check of checks) {
    const statusTag = check.passed ? "[PASS]" : "[FAIL]";
    lines.push(`  ${statusTag} ${check.name}: ${check.message}`);
    if (!check.passed && check.details) {
      lines.push(`         Details: ${check.details}`);
    }
  }
  lines.push("");

  if (!isValid && failureReason) {
    lines.push("FAILURE DETAILS:");
    lines.push(failureReason);
    lines.push("");
  }

  lines.push("PROPOSED UNIFIED DIFF:");
  lines.push(proposal.diff);
  lines.push("");

  lines.push("EXPLANATION:");
  lines.push(proposal.explanation);
  lines.push("");

  lines.push("NOTICE:");
  lines.push(SYNTAX_VALIDATION_DISCLAIMER);

  return lines.join("\n").trimEnd();
}

/**
 * Validates a proposed code change without modifying any repository files.
 *
 * Validation pipeline:
 * 1. Checks file existence on disk (or in custom reader).
 * 2. Checks line range validity.
 * 3. Confirms original code matches current file content on disk (stale index / drift check).
 * 4. Simulates replacement purely in memory.
 * 5. Parses simulated file using Tree-sitter AST and verifies zero syntax errors.
 * 6. Returns a typed ValidatedChangePlan with checks and a formatted preview.
 */
export async function validateProposedChange(
  proposal: ProposedChange,
  options?: ValidateChangeOptions
): Promise<ValidatedChangePlan> {
  const checks: ValidationCheck[] = [];

  const rawFilePath = proposal.file || proposal.targetFile;
  const filePath = options?.repoRoot
    ? path.resolve(options.repoRoot, rawFilePath)
    : rawFilePath;

  // 1. File existence check
  let fileContent: string | undefined;

  if (options?.readFileFn) {
    try {
      fileContent = options.readFileFn(filePath);
      checks.push({
        id: "file_exists",
        name: "File Existence",
        passed: true,
        message: `File found: ${filePath}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        id: "file_exists",
        name: "File Existence",
        passed: false,
        message: `Target file not found or unreadable: ${filePath}`,
        details: msg,
      });
    }
  } else {
    if (fs.existsSync(filePath)) {
      try {
        fileContent = fs.readFileSync(filePath, "utf8");
        checks.push({
          id: "file_exists",
          name: "File Existence",
          passed: true,
          message: `File exists on disk: ${filePath}`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          id: "file_exists",
          name: "File Existence",
          passed: false,
          message: `Failed to read target file: ${filePath}`,
          details: msg,
        });
      }
    } else {
      checks.push({
        id: "file_exists",
        name: "File Existence",
        passed: false,
        message: `Target file not found on disk: ${filePath}`,
      });
    }
  }

  // If file doesn't exist, we cannot perform downstream checks
  if (fileContent === undefined) {
    const preview = formatDryRunPreview(
      proposal,
      checks,
      false,
      checks[0]?.message
    );
    return {
      isValid: false,
      proposal,
      checks,
      preview,
      failureReason: checks[0]?.message,
      syntaxNotice: SYNTAX_VALIDATION_DISCLAIMER,
    };
  }

  // 2. Line range validity check
  const fileLines = fileContent.split(/\r?\n/);
  const totalLines = fileLines.length;
  const startLine = proposal.startLine;
  const endLine = proposal.endLine;

  const isRangeValid =
    startLine >= 1 &&
    endLine >= startLine &&
    startLine <= totalLines &&
    endLine <= totalLines;

  if (!isRangeValid) {
    checks.push({
      id: "line_range_valid",
      name: "Line Boundaries",
      passed: false,
      message: `Invalid line range ${startLine}-${endLine}. Target file has ${totalLines} line(s).`,
      details:
        startLine < 1
          ? "Start line must be >= 1."
          : startLine > endLine
          ? "Start line cannot be greater than end line."
          : `Line range exceeds file length (${totalLines} lines).`,
    });

    const preview = formatDryRunPreview(
      proposal,
      checks,
      false,
      checks[checks.length - 1]?.message
    );
    return {
      isValid: false,
      proposal,
      checks,
      preview,
      failureReason: checks[checks.length - 1]?.message,
      syntaxNotice: SYNTAX_VALIDATION_DISCLAIMER,
    };
  }

  checks.push({
    id: "line_range_valid",
    name: "Line Boundaries",
    passed: true,
    message: `Lines ${startLine}-${endLine} within file bounds (${totalLines} lines total)`,
  });

  // 3. Source freshness / match check (normalizing line endings only)
  const currentLinesCode = extractSourceLines(fileContent, startLine, endLine);
  if (currentLinesCode === null) {
    checks.push({
      id: "source_match",
      name: "Source Freshness",
      passed: false,
      message: `Failed to extract lines ${startLine}-${endLine} from ${filePath}.`,
    });
  } else {
    const normDisk = currentLinesCode.replace(/\r\n/g, "\n");
    const normOriginal = (proposal.originalCode ?? "").replace(/\r\n/g, "\n");

    if (normDisk !== normOriginal) {
      checks.push({
        id: "source_match",
        name: "Source Freshness",
        passed: false,
        message: `Target source in '${rawFilePath}' has changed since the change proposal was generated.`,
        details: `Original code at lines ${startLine}-${endLine} does not match current file content. Please re-analyze the change.`,
      });

      const preview = formatDryRunPreview(
        proposal,
        checks,
        false,
        checks[checks.length - 1]?.message
      );
      return {
        isValid: false,
        proposal,
        checks,
        preview,
        failureReason: checks[checks.length - 1]?.message,
        syntaxNotice: SYNTAX_VALIDATION_DISCLAIMER,
      };
    }

    checks.push({
      id: "source_match",
      name: "Source Freshness",
      passed: true,
      message: "Current disk content matches proposed baseline exactly",
    });
  }

  // 4. Grammar and language support check
  const langInfo = getFileLanguageInfo(rawFilePath);
  if (!langInfo) {
    checks.push({
      id: "language_supported",
      name: "Grammar Support",
      passed: false,
      message: `Unsupported language grammar for file: '${rawFilePath}'. Only JavaScript (.js, .jsx) and TypeScript (.ts, .tsx) are supported for AST syntax validation.`,
    });

    const preview = formatDryRunPreview(
      proposal,
      checks,
      false,
      checks[checks.length - 1]?.message
    );
    return {
      isValid: false,
      proposal,
      checks,
      preview,
      failureReason: checks[checks.length - 1]?.message,
      syntaxNotice: SYNTAX_VALIDATION_DISCLAIMER,
    };
  }

  checks.push({
    id: "language_supported",
    name: "Grammar Support",
    passed: true,
    message: `Supported language (${langInfo.language}, grammar: ${langInfo.grammar})`,
  });

  // 5. In-memory replacement simulation
  const simulation = simulateReplacement(
    fileContent,
    startLine,
    endLine,
    proposal.proposedCode
  );

  // 6. Tree-sitter AST syntax validation
  let hasSyntaxError = false;
  let syntaxErrorDetails: SyntaxErrorDetail[] = [];

  try {
    const tree = await treeSitterService.parse(
      simulation.simulatedContent,
      langInfo.grammar
    );
    hasSyntaxError = Boolean(tree.rootNode.hasError);

    if (hasSyntaxError) {
      syntaxErrorDetails = extractTreeSitterErrors(tree.rootNode);
    }
  } catch (err: unknown) {
    hasSyntaxError = true;
    const msg = err instanceof Error ? err.message : String(err);
    syntaxErrorDetails = [
      {
        line: 1,
        column: 1,
        message: `Tree-sitter parser failed: ${msg}`,
      },
    ];
  }

  if (hasSyntaxError) {
    const detailMsg =
      syntaxErrorDetails.length > 0
        ? syntaxErrorDetails.map((e) => e.message).join("; ")
        : "Unknown syntax error detected in simulated AST.";

    checks.push({
      id: "syntax_valid",
      name: "AST Syntax",
      passed: false,
      message: `Syntax validation failed for simulated ${langInfo.grammar} code.`,
      details: detailMsg,
    });
  } else {
    checks.push({
      id: "syntax_valid",
      name: "AST Syntax",
      passed: true,
      message:
        "Tree-sitter AST parsed successfully without syntax errors (grammatical validity confirmed; does not prove semantic correctness).",
    });
  }

  const isValid = checks.every((c) => c.passed);
  const failureReason = isValid
    ? undefined
    : checks.find((c) => !c.passed)?.details ?? checks.find((c) => !c.passed)?.message;

  const preview = formatDryRunPreview(proposal, checks, isValid, failureReason);

  return {
    isValid,
    proposal,
    checks,
    simulatedContent: simulation.simulatedContent,
    preview,
    failureReason,
    syntaxNotice: SYNTAX_VALIDATION_DISCLAIMER,
  };
}
