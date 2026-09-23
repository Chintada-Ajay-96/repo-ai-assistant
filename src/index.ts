import { buildRepoMap } from "./repoMap";

async function main() {
  const map = await buildRepoMap("sample-repo");
  console.log(JSON.stringify(map, null, 2));
}

main();