import { buildRepoChunks } from "./codeChunks.js";

async function main() {
  const targetDir = process.argv[2] || "sample-repo";
  const chunks = await buildRepoChunks(targetDir);

  console.log(`Generated ${chunks.length} code chunk(s) for "${targetDir}":\n`);
  for (const chunk of chunks) {
    const parentInfo = chunk.parent ? ` (parent: ${chunk.parent})` : "";
    console.log(`--- [${chunk.type.toUpperCase()}] ${chunk.symbol}${parentInfo} (${chunk.file}:${chunk.startLine}-${chunk.endLine}) ---`);
    console.log(chunk.code);
    console.log();
  }
}

main().catch((err: unknown) => {
  console.error("Failed to generate code chunks:", err);
  process.exit(1);
});