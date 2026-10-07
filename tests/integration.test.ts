import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRepoMap } from "../src/repoMap.js";
import { normalizePath } from "../src/utils/walkRepo.js";

describe("Integration - Repository Mapping", () => {
  it("should match exact expected output on sample-repo", async () => {
    const map = await buildRepoMap("sample-repo");
    assert.equal(map.length, 1);

    const authFile = map[0]!;
    assert.equal(normalizePath(authFile.file), "sample-repo/auth.js");
    assert.equal(authFile.language, "javascript");

    assert.deepEqual(authFile.symbols, [
      {
        type: "function",
        name: "generateToken",
        startLine: 1,
        endLine: 3,
      },
      {
        type: "function",
        name: "verifyToken",
        startLine: 5,
        endLine: 7,
      },
      {
        type: "class",
        name: "AuthService",
        startLine: 9,
        endLine: 13,
      },
      {
        type: "method",
        name: "login",
        startLine: 10,
        endLine: 12,
        parent: "AuthService",
      },
    ]);
  });

  it("should generate repository map across multiple files and languages", async () => {
    const map = await buildRepoMap("tests/fixtures");
    assert.ok(map.length >= 4, "Should find multiple fixture files");

    for (const entry of map) {
      assert.ok(typeof entry.file === "string");
      assert.ok(entry.language === "javascript" || entry.language === "typescript");
      assert.ok(Array.isArray(entry.symbols));

      for (const sym of entry.symbols) {
        assert.ok(["function", "arrow_function", "class", "method", "constructor", "interface", "type_alias"].includes(sym.type));
        assert.ok(typeof sym.name === "string");
        assert.ok(typeof sym.startLine === "number" && sym.startLine > 0);
        assert.ok(typeof sym.endLine === "number" && sym.endLine >= sym.startLine);
      }
    }
  });
});
