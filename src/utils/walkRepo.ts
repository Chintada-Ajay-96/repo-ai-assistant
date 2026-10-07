import * as fs from "node:fs";
import * as path from "node:path";

export type SupportedLanguage = "javascript" | "typescript";
export type GrammarType = "javascript" | "typescript" | "tsx";

export interface FileLanguageInfo {
  language: SupportedLanguage;
  grammar: GrammarType;
}

export const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

export const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function getFileLanguageInfo(filePath: string): FileLanguageInfo | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".js":
      return { language: "javascript", grammar: "javascript" };
    case ".jsx":
      return { language: "javascript", grammar: "javascript" };
    case ".ts":
      return { language: "typescript", grammar: "typescript" };
    case ".tsx":
      return { language: "typescript", grammar: "tsx" };
    default:
      return null;
  }
}

export function detectLanguage(filePath: string): SupportedLanguage | null {
  return getFileLanguageInfo(filePath)?.language ?? null;
}

export function isSupportedFile(filePath: string): boolean {
  return getFileLanguageInfo(filePath) !== null;
}

export function getAllSourceFiles(
  dir: string,
  ignoredDirs: Set<string> = IGNORE_DIRS,
  files: string[] = []
): string[] {
  if (!fs.existsSync(dir)) {
    return files;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return files;
  }

  if (stat.isFile()) {
    if (isSupportedFile(dir)) {
      files.push(normalizePath(dir));
    }
    return files;
  }

  if (!stat.isDirectory()) {
    return files;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        getAllSourceFiles(fullPath, ignoredDirs, files);
      }
    } else if (entry.isFile()) {
      if (isSupportedFile(entry.name)) {
        files.push(normalizePath(fullPath));
      }
    }
  }

  return files;
}