import Parser from "web-tree-sitter";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
  getAllSourceFiles,
  getFileLanguageInfo,
  type GrammarType,
  type SupportedLanguage,
} from "./utils/walkRepo.js";

const require = createRequire(import.meta.url);

export type SymbolType =
  | "function"
  | "arrow_function"
  | "class"
  | "method"
  | "constructor"
  | "interface"
  | "type_alias";

export interface SymbolInfo {
  type: SymbolType;
  name: string;
  startLine: number;
  endLine: number;
  parent?: string;
}

export interface FileMap {
  file: string;
  language: SupportedLanguage;
  symbols: SymbolInfo[];
  error?: string;
}

function getWasmPath(grammar: GrammarType): string {
  const fileName = `tree-sitter-${grammar}.wasm`;
  try {
    const pkgPath = require.resolve("tree-sitter-wasms/package.json");
    const wasmPath = path.join(path.dirname(pkgPath), "out", fileName);
    if (fs.existsSync(wasmPath)) {
      return wasmPath;
    }
  } catch {
    // fallback to searching relative to cwd
  }

  const fallback = path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out", fileName);
  if (fs.existsSync(fallback)) {
    return fallback;
  }

  throw new Error(`Tree-sitter WASM file not found for grammar: ${grammar}`);
}

class TreeSitterService {
  private parser: Parser | null = null;
  private languages = new Map<GrammarType, Parser.Language>();
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Parser.init();
    }
    await this.initPromise;
    if (!this.parser) {
      this.parser = new Parser();
    }
  }

  async getLanguage(grammar: GrammarType): Promise<Parser.Language> {
    let lang = this.languages.get(grammar);
    if (!lang) {
      await this.init();
      const wasmPath = getWasmPath(grammar);
      lang = await Parser.Language.load(wasmPath);
      this.languages.set(grammar, lang);
    }
    return lang;
  }

  async parse(code: string, grammar: GrammarType): Promise<Parser.Tree> {
    await this.init();
    const lang = await this.getLanguage(grammar);
    this.parser!.setLanguage(lang);
    return this.parser!.parse(code);
  }
}

export const treeSitterService = new TreeSitterService();

function unwrapExpression(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  let current = node;
  while (current) {
    if (current.type === "parenthesized_expression") {
      current = current.firstNamedChild;
    } else if (current.type === "as_expression" || current.type === "type_assertion") {
      current = current.childForFieldName("expression") || current.firstNamedChild;
    } else {
      break;
    }
  }
  return current;
}

export function walk(node: Parser.SyntaxNode, symbols: SymbolInfo[], parent?: string): void {
  // 1. Function declarations & generator functions
  if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? nameNode.text : "anonymous";
    symbols.push({
      type: "function",
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
    });
    for (const child of node.children) {
      walk(child, symbols, name);
    }
    return;
  }

  // 2. Class declarations & abstract classes
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    const nameNode = node.childForFieldName("name");
    const className = nameNode ? nameNode.text : "anonymous";
    symbols.push({
      type: "class",
      name: className,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
    });
    for (const child of node.children) {
      walk(child, symbols, className);
    }
    return;
  }

  // 3. Class methods and constructors
  if (node.type === "method_definition") {
    const nameNode = node.childForFieldName("name");
    const methodName = nameNode ? nameNode.text : "anonymous";
    const isConstructor = methodName === "constructor";
    symbols.push({
      type: isConstructor ? "constructor" : "method",
      name: methodName,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
    });
    for (const child of node.children) {
      walk(child, symbols, methodName);
    }
    return;
  }

  // 4. TypeScript interfaces
  if (node.type === "interface_declaration") {
    const nameNode = node.childForFieldName("name");
    symbols.push({
      type: "interface",
      name: nameNode ? nameNode.text : "anonymous",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
    });
    return;
  }

  // 5. TypeScript type aliases
  if (node.type === "type_alias_declaration") {
    const nameNode = node.childForFieldName("name");
    symbols.push({
      type: "type_alias",
      name: nameNode ? nameNode.text : "anonymous",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
    });
    return;
  }

  // 6. Variable declarators (arrow functions, function expressions, class expressions)
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const rawValueNode = node.childForFieldName("value");
    const valueNode = unwrapExpression(rawValueNode);

    if (valueNode) {
      if (valueNode.type === "arrow_function") {
        const name = nameNode ? nameNode.text : "anonymous";
        symbols.push({
          type: "arrow_function",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(parent ? { parent } : {}),
        });
        for (const child of node.children) {
          walk(child, symbols, name);
        }
        return;
      }

      if (valueNode.type === "function_expression" || valueNode.type === "generator_function") {
        const name = nameNode ? nameNode.text : "anonymous";
        symbols.push({
          type: "function",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(parent ? { parent } : {}),
        });
        for (const child of node.children) {
          walk(child, symbols, name);
        }
        return;
      }

      if (valueNode.type === "class" || valueNode.type === "class_expression") {
        const name = nameNode ? nameNode.text : "anonymous";
        symbols.push({
          type: "class",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(parent ? { parent } : {}),
        });
        for (const child of node.children) {
          walk(child, symbols, name);
        }
        return;
      }
    }
  }

  // 7. Class field definitions (e.g. bound arrow functions in classes)
  if (node.type === "field_definition" || node.type === "public_field_definition") {
    const nameNode = node.childForFieldName("name");
    const rawValueNode = node.childForFieldName("value");
    const valueNode = unwrapExpression(rawValueNode);

    if (valueNode) {
      if (valueNode.type === "arrow_function") {
        const name = nameNode ? nameNode.text : "anonymous";
        symbols.push({
          type: "arrow_function",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(parent ? { parent } : {}),
        });
        return;
      }

      if (valueNode.type === "function_expression" || valueNode.type === "generator_function") {
        const name = nameNode ? nameNode.text : "anonymous";
        symbols.push({
          type: "function",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ...(parent ? { parent } : {}),
        });
        return;
      }
    }
  }

  // Default: recurse into children
  for (const child of node.children) {
    walk(child, symbols, parent);
  }
}

export async function extractSymbols(
  code: string,
  grammar: GrammarType
): Promise<SymbolInfo[]> {
  const tree = await treeSitterService.parse(code, grammar);
  const symbols: SymbolInfo[] = [];
  walk(tree.rootNode, symbols);
  tree.delete();
  return symbols;
}

export async function parseFile(filePath: string): Promise<FileMap> {
  const langInfo = getFileLanguageInfo(filePath);
  if (!langInfo) {
    throw new Error(`Unsupported file type: ${filePath}`);
  }

  const { language, grammar } = langInfo;

  try {
    const code = fs.readFileSync(filePath, "utf8");
    const tree = await treeSitterService.parse(code, grammar);
    const symbols: SymbolInfo[] = [];
    walk(tree.rootNode, symbols);
    tree.delete();
    return {
      file: filePath,
      language,
      symbols,
    };
  } catch (error) {
    return {
      file: filePath,
      language,
      symbols: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildRepoMap(rootDir: string): Promise<FileMap[]> {
  const files = getAllSourceFiles(rootDir);
  const results: FileMap[] = [];

  for (const file of files) {
    try {
      const fileMap = await parseFile(file);
      results.push(fileMap);
    } catch (error) {
      const langInfo = getFileLanguageInfo(file);
      results.push({
        file,
        language: langInfo?.language ?? ("javascript" as SupportedLanguage),
        symbols: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}