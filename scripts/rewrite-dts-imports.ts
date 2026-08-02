import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist/types");

async function rewriteDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDirectory(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const source = await readFile(path, "utf8");
    const rewritten = source.replace(/(from\s+["'][^"']+)\.ts(["'])/gu, "$1.js$2");
    if (rewritten !== source) await writeFile(path, rewritten, "utf8");
  }
}

await rewriteDirectory(root);
