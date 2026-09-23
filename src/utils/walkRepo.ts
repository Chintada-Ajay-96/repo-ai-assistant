import * as fs from "fs";
import * as path from "path";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

export function getAllSourceFiles(dir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        getAllSourceFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      if (fullPath.endsWith(".js") || fullPath.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}