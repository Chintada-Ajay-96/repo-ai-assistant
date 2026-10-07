import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { parseFile, extractSymbols, buildRepoMap } from "../src/repoMap.js";

describe("repoMap - Symbol Extraction & Language Parsing", () => {
  it("should extract function declarations, arrow functions, and function expressions from JavaScript", async () => {
    const filePath = path.join("tests", "fixtures", "js", "math.js");
    const result = await parseFile(filePath);

    assert.equal(result.language, "javascript");
    assert.equal(result.symbols.length, 3);

    const [fnDecl, arrowFn, fnExpr] = result.symbols;
    assert.deepEqual(fnDecl, {
      type: "function",
      name: "add",
      startLine: 1,
      endLine: 3,
    });
    assert.deepEqual(arrowFn, {
      type: "arrow_function",
      name: "multiply",
      startLine: 5,
      endLine: 7,
    });
    assert.deepEqual(fnExpr, {
      type: "function",
      name: "divide",
      startLine: 9,
      endLine: 11,
    });
  });

  it("should extract JSX components, classes, constructors, and methods from JSX", async () => {
    const filePath = path.join("tests", "fixtures", "js", "service.jsx");
    const result = await parseFile(filePath);

    assert.equal(result.language, "javascript");
    
    const types = result.symbols.map(s => s.type);
    const names = result.symbols.map(s => s.name);

    assert.ok(names.includes("Button"));
    assert.ok(names.includes("Calculator"));
    assert.ok(names.includes("constructor"));
    assert.ok(names.includes("add"));

    const ctor = result.symbols.find(s => s.name === "constructor");
    assert.equal(ctor?.parent, "Calculator");
    assert.equal(ctor?.type, "constructor");

    const method = result.symbols.find(s => s.name === "add");
    assert.equal(method?.parent, "Calculator");
    assert.equal(method?.type, "method");
  });

  it("should extract interfaces, type aliases, classes, methods, and bound arrows from TypeScript", async () => {
    const filePath = path.join("tests", "fixtures", "ts", "models.ts");
    const result = await parseFile(filePath);

    assert.equal(result.language, "typescript");

    const iface = result.symbols.find(s => s.name === "User");
    assert.ok(iface);
    assert.equal(iface.type, "interface");

    const typeAlias = result.symbols.find(s => s.name === "UserId");
    assert.ok(typeAlias);
    assert.equal(typeAlias.type, "type_alias");

    const cls = result.symbols.find(s => s.name === "UserManager");
    assert.ok(cls);
    assert.equal(cls.type, "class");

    const ctor = result.symbols.find(s => s.name === "constructor");
    assert.ok(ctor);
    assert.equal(ctor.type, "constructor");
    assert.equal(ctor.parent, "UserManager");

    const method = result.symbols.find(s => s.name === "findUser");
    assert.ok(method);
    assert.equal(method.type, "method");
    assert.equal(method.parent, "UserManager");

    const arrowField = result.symbols.find(s => s.name === "clear");
    assert.ok(arrowField);
    assert.equal(arrowField.type, "arrow_function");
    assert.equal(arrowField.parent, "UserManager");
  });

  it("should extract TSX components and interface props", async () => {
    const filePath = path.join("tests", "fixtures", "ts", "component.tsx");
    const result = await parseFile(filePath);

    assert.equal(result.language, "typescript");

    const iface = result.symbols.find(s => s.name === "WidgetProps");
    assert.ok(iface);
    assert.equal(iface.type, "interface");

    const comp = result.symbols.find(s => s.name === "Widget");
    assert.ok(comp);
    assert.equal(comp.type, "arrow_function");
  });

  it("should handle abstract classes and generator functions", async () => {
    const code = `
      export abstract class AbstractBase {
        abstract run(): void;
      }
      export function* counterGen() {
        yield 1;
      }
    `;
    const symbols = await extractSymbols(code, "typescript");

    const absClass = symbols.find(s => s.name === "AbstractBase");
    assert.ok(absClass);
    assert.equal(absClass.type, "class");

    const gen = symbols.find(s => s.name === "counterGen");
    assert.ok(gen);
    assert.equal(gen.type, "function");
  });

  it("should handle files with syntax errors gracefully without crashing", async () => {
    const filePath = path.join("tests", "fixtures", "invalid", "broken.js");
    const result = await parseFile(filePath);

    // Tree-sitter is fault tolerant, it should still process the file without throwing
    assert.equal(result.language, "javascript");
    assert.ok(Array.isArray(result.symbols));
  });

  it("should handle unreadable files gracefully", async () => {
    const result = await parseFile("non/existent/file.js");
    assert.equal(result.symbols.length, 0);
    assert.ok(result.error);
  });
});
