import * as fs from "node:fs";
import {
  buildRepoMap,
  type FileMap,
  type SymbolInfo,
} from "./repoMap.js";

export interface CodeChunk {
  file: string;
  language: string;
  symbol: string;
  type: string;
  startLine: number;
  endLine: number;
  code: string;
  parent?: string;
}

/**
 * Extracts lines of source code from startLine to endLine (1-indexed, inclusive).
 * Returns null if the line range is invalid or out of bounds.
 */
export function extractSourceLines(
  source: string,
  startLine: number,
  endLine: number
): string | null {
  if (startLine < 1 || endLine < startLine) {
    return null;
  }

  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || startLine > lines.length) {
    return null;
  }

  const clampedEnd = Math.min(endLine, lines.length);
  return lines.slice(startLine - 1, clampedEnd).join("\n");
}

/**
 * Creates CodeChunks from a single FileMap.
 * If fileContent is not provided, reads the file from disk using fs.readFileSync.
 */
export function createChunksFromFileMap(
  fileMap: FileMap,
  fileContent?: string
): CodeChunk[] {
  if (fileMap.error || !fileMap.symbols || fileMap.symbols.length === 0) {
    return [];
  }

  let content = fileContent;
  if (content === undefined) {
    try {
      content = fs.readFileSync(fileMap.file, "utf8");
    } catch {
      return [];
    }
  }

  const chunks: CodeChunk[] = [];
  const seenKeys = new Set<string>();

  for (const sym of fileMap.symbols) {
    const code = extractSourceLines(content, sym.startLine, sym.endLine);
    if (code === null) {
      continue;
    }

    const key = `${fileMap.file}:${sym.name}:${sym.type}:${sym.startLine}:${sym.endLine}:${sym.parent ?? ""}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const chunk: CodeChunk = {
      file: fileMap.file,
      language: fileMap.language,
      symbol: sym.name,
      type: sym.type,
      startLine: sym.startLine,
      endLine: sym.endLine,
      code,
      ...(sym.parent ? { parent: sym.parent } : {}),
    };

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Converts an array of FileMaps into an array of CodeChunks.
 * Accepts an optional readFileFn (defaults to fs.readFileSync) for custom I/O or testing.
 */
export function createChunksFromRepoMap(
  repoMaps: FileMap[],
  readFileFn?: (filePath: string) => string
): CodeChunk[] {
  const allChunks: CodeChunk[] = [];

  for (const fileMap of repoMaps) {
    let content: string | undefined;
    if (readFileFn) {
      try {
        content = readFileFn(fileMap.file);
      } catch {
        continue;
      }
    }

    const fileChunks = createChunksFromFileMap(fileMap, content);
    allChunks.push(...fileChunks);
  }

  return allChunks;
}

/**
 * High-level helper: builds the repository map and converts all symbols into CodeChunks.
 */
export async function buildRepoChunks(rootDir: string): Promise<CodeChunk[]> {
  const repoMap = await buildRepoMap(rootDir);
  return createChunksFromRepoMap(repoMap);
}
