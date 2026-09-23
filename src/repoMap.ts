import Parser from "web-tree-sitter";
import * as path from "path";
import * as fs from "fs";
import { getAllSourceFiles } from "./utils/walkRepo";

type Symbol = {
  type: string;
  name: string;
  startLine: number;
  endLine: number;
};

type FileMap = {
  file: string;
  symbols: Symbol[];
};

function walk(node: Parser.SyntaxNode, symbols: Symbol[]) {
  if (node.type === "function_declaration" || node.type === "class_declaration") {
    const nameNode = node.childForFieldName("name");
    symbols.push({
      type: node.type,
      name: nameNode ? nameNode.text : "anonymous",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  }
  for (const child of node.children) walk(child, symbols);
}

export async function buildRepoMap(rootDir: string): Promise<FileMap[]> {
  await Parser.init();
  const parser = new Parser();
  const wasmPath = path.join(
    __dirname, "..", "node_modules", "tree-sitter-wasms", "out", "tree-sitter-javascript.wasm"
  );
  const JavaScript = await Parser.Language.load(wasmPath);
  parser.setLanguage(JavaScript);

  const files = getAllSourceFiles(rootDir);

  return files.map((file) => {
    const code = fs.readFileSync(file, "utf8");
    const tree = parser.parse(code);
    const symbols: Symbol[] = [];
    walk(tree.rootNode, symbols);
    return { file, symbols };
  });
}