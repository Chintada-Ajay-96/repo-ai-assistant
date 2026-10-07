import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  getAllSourceFiles,
  detectLanguage,
  getFileLanguageInfo,
  isSupportedFile,
  normalizePath,
} from "../src/utils/walkRepo.js";

describe("walkRepo - File Discovery & Language Detection", () => {
  const ignoredProjectDir = path.join("tests", "fixtures", "ignored_project");

  it("should discover JavaScript files (.js, .jsx)", () => {
    const files = getAllSourceFiles(path.join("tests", "fixtures", "js"));
    const normalized = files.map(f => normalizePath(f));
    assert.ok(normalized.some(f => f.endsWith("math.js")), "Should find math.js");
    assert.ok(normalized.some(f => f.endsWith("service.jsx")), "Should find service.jsx");
  });

  it("should discover TypeScript files (.ts, .tsx)", () => {
    const files = getAllSourceFiles(path.join("tests", "fixtures", "ts"));
    const normalized = files.map(f => normalizePath(f));
    assert.ok(normalized.some(f => f.endsWith("models.ts")), "Should find models.ts");
    assert.ok(normalized.some(f => f.endsWith("component.tsx")), "Should find component.tsx");
  });

  it("should ignore node_modules, .git, dist, and build directories", () => {
    const files = getAllSourceFiles(ignoredProjectDir);
    const normalized = files.map(f => normalizePath(f));

    // Should include valid source files
    assert.ok(normalized.some(f => f.endsWith("src/index.js")));
    assert.ok(normalized.some(f => f.endsWith("src/helper.ts")));

    // Should NOT include files from ignored directories
    assert.ok(!normalized.some(f => f.includes("node_modules")), "Must not include node_modules");
    assert.ok(!normalized.some(f => f.includes(".git")), "Must not include .git");
    assert.ok(!normalized.some(f => f.includes("dist")), "Must not include dist");
    assert.ok(!normalized.some(f => f.includes("build")), "Must not include build");
  });

  it("should ignore non-supported file extensions", () => {
    const files = getAllSourceFiles(path.join("tests", "fixtures", "invalid"));
    const normalized = files.map(f => normalizePath(f));
    assert.ok(!normalized.some(f => f.endsWith(".txt")), "Must not include .txt files");
    assert.ok(normalized.some(f => f.endsWith("broken.js")), "Should still include .js file");
  });

  it("should correctly detect languages from file extensions", () => {
    assert.equal(detectLanguage("file.js"), "javascript");
    assert.equal(detectLanguage("file.jsx"), "javascript");
    assert.equal(detectLanguage("file.ts"), "typescript");
    assert.equal(detectLanguage("file.tsx"), "typescript");
    assert.equal(detectLanguage("file.py"), null);
    assert.equal(detectLanguage("file.json"), null);
  });

  it("should map file extensions to the correct Tree-sitter grammar", () => {
    assert.deepEqual(getFileLanguageInfo("app.js"), { language: "javascript", grammar: "javascript" });
    assert.deepEqual(getFileLanguageInfo("app.jsx"), { language: "javascript", grammar: "javascript" });
    assert.deepEqual(getFileLanguageInfo("app.ts"), { language: "typescript", grammar: "typescript" });
    assert.deepEqual(getFileLanguageInfo("app.tsx"), { language: "typescript", grammar: "tsx" });
    assert.equal(getFileLanguageInfo("app.rs"), null);
  });

  it("should return true for supported files and false for unsupported files", () => {
    assert.equal(isSupportedFile("test.js"), true);
    assert.equal(isSupportedFile("test.jsx"), true);
    assert.equal(isSupportedFile("test.ts"), true);
    assert.equal(isSupportedFile("test.tsx"), true);
    assert.equal(isSupportedFile("test.md"), false);
  });

  it("should handle non-existent directories gracefully", () => {
    const files = getAllSourceFiles("non/existent/path");
    assert.deepEqual(files, []);
  });
});
