#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distUrl = new URL("../dist/cli.js", import.meta.url);

if (process.argv[2] === "integrations") {
  const integrationScript = fileURLToPath(
    new URL("../scripts/install-integrations.mjs", import.meta.url),
  );
  if (!existsSync(integrationScript)) {
    console.error("Super Router integration installer is missing from this package.");
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [integrationScript, ...process.argv.slice(3)], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    console.error(
      `Could not start the Super Router integration installer: ${result.error.message}`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} else if (existsSync(fileURLToPath(distUrl))) {
  await import(distUrl.href);
} else {
  const sourcePath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync("bun", ["run", sourcePath, ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    console.error(
      "Super Router requires a packaged build or Bun >= 1.1. Run `bun install && bun run build`.",
    );
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
