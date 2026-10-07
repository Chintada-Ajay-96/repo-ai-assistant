import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  extractSourceLines,
  createChunksFromFileMap,
  createChunksFromRepoMap,
  buildRepoChunks,
  type CodeChunk,
} from "../src/codeChunks.js";
import { type FileMap } from "../src/repoMap.js";
import { normalizePath } from "../src/utils/walkRepo.js";

describe("codeChunks - Code Chunking (Phase 2A)", () => {
  it("should accurately extract exact start and end lines", () => {
    const source = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
    ].join("\n");

    // Single line
    assert.equal(extractSourceLines(source, 1, 1), "line 1");
    assert.equal(extractSourceLines(source, 3, 3), "line 3");

    // Multi-line range
    assert.equal(extractSourceLines(source, 2, 4), "line 2\nline 3\nline 4");

    // Full range
    assert.equal(extractSourceLines(source, 1, 5), source);

    // Preserves indentation
    const indented = "function foo() {\n  const x = 1;\n  return x;\n}";
    assert.equal(extractSourceLines(indented, 2, 3), "  const x = 1;\n  return x;");
  });

  it("should handle invalid line range boundaries gracefully", () => {
    const source = "line 1\nline 2";

    // startLine < 1
    assert.equal(extractSourceLines(source, 0, 2), null);
    // startLine > endLine
    assert.equal(extractSourceLines(source, 2, 1), null);
    // startLine beyond file length
    assert.equal(extractSourceLines(source, 10, 12), null);
  });

  it("should convert a JavaScript function into a correct code chunk", async () => {
    const chunks = await buildRepoChunks("sample-repo");
    const fnChunk = chunks.find(c => c.symbol === "generateToken");

    assert.ok(fnChunk, "Should find generateToken chunk");
    assert.equal(normalizePath(fnChunk.file), "sample-repo/auth.js");
    assert.equal(fnChunk.language, "javascript");
    assert.equal(fnChunk.type, "function");
    assert.equal(fnChunk.startLine, 1);
    assert.equal(fnChunk.endLine, 3);
    assert.equal(
      fnChunk.code,
      "function generateToken(user) {\n  return jwt.sign({ id: user.id }, SECRET);\n}"
    );
  });

  it("should convert class and class method into distinct, correct chunks with parent relationship", async () => {
    const chunks = await buildRepoChunks("sample-repo");

    // Class chunk
    const classChunk = chunks.find(c => c.symbol === "AuthService");
    assert.ok(classChunk, "Should find AuthService chunk");
    assert.equal(classChunk.type, "class");
    assert.equal(classChunk.startLine, 9);
    assert.equal(classChunk.endLine, 13);
    assert.equal(
      classChunk.code,
      "class AuthService {\n  login(user) {\n    return generateToken(user);\n  }\n}"
    );

    // Method chunk
    const methodChunk = chunks.find(c => c.symbol === "login");
    assert.ok(methodChunk, "Should find login method chunk");
    assert.equal(methodChunk.type, "method");
    assert.equal(methodChunk.parent, "AuthService");
    assert.equal(methodChunk.startLine, 10);
    assert.equal(methodChunk.endLine, 12);
    assert.equal(
      methodChunk.code,
      "  login(user) {\n    return generateToken(user);\n  }"
    );
  });

  it("should convert an arrow function into a correct code chunk", async () => {
    const chunks = await buildRepoChunks(path.join("tests", "fixtures", "js"));
    const arrowChunk = chunks.find(c => c.symbol === "multiply");

    assert.ok(arrowChunk, "Should find multiply arrow function chunk");
    assert.equal(arrowChunk.type, "arrow_function");
    assert.equal(arrowChunk.startLine, 5);
    assert.equal(arrowChunk.endLine, 7);
    assert.equal(
      arrowChunk.code,
      "const multiply = (a, b) => {\n  return a * b;\n};"
    );
  });

  it("should convert TypeScript interface and type alias into correct chunks", async () => {
    const chunks = await buildRepoChunks(path.join("tests", "fixtures", "ts"));

    // Interface chunk
    const ifaceChunk = chunks.find(c => c.symbol === "User");
    assert.ok(ifaceChunk, "Should find User interface chunk");
    assert.equal(ifaceChunk.type, "interface");
    assert.equal(ifaceChunk.language, "typescript");
    assert.equal(ifaceChunk.code, "export interface User {\n  id: string;\n  name: string;\n}");

    // Type alias chunk
    const typeChunk = chunks.find(c => c.symbol === "UserId");
    assert.ok(typeChunk, "Should find UserId type alias chunk");
    assert.equal(typeChunk.type, "type_alias");
    assert.equal(typeChunk.language, "typescript");
    assert.equal(typeChunk.code, "export type UserId = string | number;");
  });

  it("should convert TSX component into a correct chunk", async () => {
    const chunks = await buildRepoChunks(path.join("tests", "fixtures", "ts"));
    const widgetChunk = chunks.find(c => c.symbol === "Widget");

    assert.ok(widgetChunk, "Should find Widget TSX component chunk");
    assert.equal(widgetChunk.type, "arrow_function");
    assert.equal(widgetChunk.language, "typescript");
    assert.ok(widgetChunk.code.includes('<div className="widget">{title}</div>'));
  });

  it("should generate chunks across multiple files in a repository", async () => {
    const chunks = await buildRepoChunks("tests/fixtures");
    assert.ok(chunks.length >= 8, "Should extract multiple chunks across fixtures");

    // Chunks should come from multiple distinct files
    const uniqueFiles = new Set(chunks.map(c => normalizePath(c.file)));
    assert.ok(uniqueFiles.size >= 3, "Chunks must span multiple files");
  });

  it("should avoid creating duplicate chunks for the same symbol", () => {
    const fileMap: FileMap = {
      file: "test.js",
      language: "javascript",
      symbols: [
        {
          type: "function",
          name: "foo",
          startLine: 1,
          endLine: 3,
        },
        // Duplicate entry for same symbol and line range
        {
          type: "function",
          name: "foo",
          startLine: 1,
          endLine: 3,
        },
      ],
    };

    const content = "function foo() {\n  return 1;\n}\n";
    const chunks = createChunksFromFileMap(fileMap, content);

    assert.equal(chunks.length, 1, "Should deduplicate identical symbol entries");
  });

  it("should gracefully handle unreadable files and empty files", () => {
    // Unreadable file
    const unreadableMap: FileMap = {
      file: "non/existent/missing.js",
      language: "javascript",
      symbols: [
        {
          type: "function",
          name: "missing",
          startLine: 1,
          endLine: 2,
        },
      ],
    };
    const unreadableChunks = createChunksFromFileMap(unreadableMap);
    assert.deepEqual(unreadableChunks, [], "Should return empty array for unreadable file without crashing");

    // Empty file
    const emptyMap: FileMap = {
      file: "empty.js",
      language: "javascript",
      symbols: [],
    };
    const emptyChunks = createChunksFromFileMap(emptyMap, "");
    assert.deepEqual(emptyChunks, [], "Should return empty array for empty file");

    // FileMap with error
    const errorMap: FileMap = {
      file: "broken.js",
      language: "javascript",
      symbols: [],
      error: "Syntax error",
    };
    const errorChunks = createChunksFromFileMap(errorMap);
    assert.deepEqual(errorChunks, [], "Should return empty array for FileMap with error");
  });
});
