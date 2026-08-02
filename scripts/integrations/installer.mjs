import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "@dmarigliano/super-router";
const SCHEMA_VERSION = 1;
const VERSION = "0.8.0";
const MARKER_FILE = ".super-router-integration.json";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUPPORTS_NOFOLLOW =
  typeof fsConstants.O_NOFOLLOW === "number" && fsConstants.O_NOFOLLOW !== 0;
const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const DEFINITIONS = {
  codex: {
    label: "Codex",
    sourceRoot: "integrations/codex/skills/super-router",
    userTarget: [".agents", "skills", "super-router"],
    projectTarget: [".agents", "skills", "super-router"],
    files: ["SKILL.md", "agents/openai.yaml", "scripts/invoke.mjs"],
  },
  "claude-code": {
    label: "Claude Code",
    sourceRoot: "integrations/claude-code/standalone",
    userTarget: [".claude", "skills", "super-router"],
    projectTarget: [".claude", "skills", "super-router"],
    files: ["SKILL.md", "scripts/invoke.mjs"],
  },
};

export async function runIntegrationCommand(options) {
  const {
    action,
    integrations,
    scope,
    projectDir,
    force = false,
    dryRun = false,
    homeDir = homedir(),
    repositoryRoot = REPOSITORY_ROOT,
  } = options;

  if (action !== "install" && action !== "uninstall") {
    throw new Error("action must be install or uninstall");
  }
  if (scope !== "user" && scope !== "project") {
    throw new Error("scope must be user or project");
  }
  if (!Array.isArray(integrations) || integrations.length === 0) {
    throw new Error("at least one integration is required");
  }

  const baseInput = scope === "user" ? homeDir : projectDir;
  if (!baseInput) throw new Error("--project-dir is required for project scope");
  const base = await resolveExistingDirectory(baseInput, scope === "user" ? "home" : "project");
  const results = [];

  for (const integration of integrations) {
    const definition = DEFINITIONS[integration];
    if (!definition) throw new Error(`unsupported integration: ${integration}`);
    const targetParts = scope === "user" ? definition.userTarget : definition.projectTarget;
    const target = resolve(base, ...targetParts);
    assertInside(base, target, `${definition.label} target`);

    const result =
      action === "install"
        ? await installIntegration({
            base,
            definition,
            dryRun,
            force,
            integration,
            repositoryRoot,
            target,
          })
        : await uninstallIntegration({ base, definition, dryRun, force, integration, target });
    results.push(result);
  }

  return results;
}

async function installIntegration({
  base,
  definition,
  dryRun,
  force,
  integration,
  repositoryRoot,
  target,
}) {
  const sources = await readAllowedSources(repositoryRoot, definition);
  await assertNoSymlinkComponents(base, target);
  const targetStat = await optionalLstat(target);
  if (targetStat?.isSymbolicLink()) throw new Error(`refusing symlink target: ${target}`);
  if (targetStat && !targetStat.isDirectory())
    throw new Error(`target is not a directory: ${target}`);

  const markerPath = join(target, MARKER_FILE);
  const existingMarker = await readMarker(markerPath, integration);
  if (targetStat && !existingMarker) {
    const entries = await readdir(target);
    if (entries.length > 0 && !force) {
      throw new Error(
        `${definition.label} target already contains unmanaged files; rerun with --force to adopt only the documented Super Router paths: ${target}`,
      );
    }
  }

  if (existingMarker) {
    await verifyManagedFiles(target, existingMarker, force, definition.label);
  }

  for (const source of sources) {
    const destination = resolve(target, source.relativePath);
    assertInside(target, destination, "managed file");
    const destinationStat = await optionalLstat(destination);
    if (destinationStat?.isSymbolicLink()) {
      throw new Error(`refusing symlink destination: ${destination}`);
    }
    if (destinationStat && !destinationStat.isFile()) {
      throw new Error(`managed destination is not a regular file: ${destination}`);
    }
    if (destinationStat && !existingMarker?.files[source.relativePath] && !force) {
      throw new Error(`refusing to overwrite unmanaged file: ${destination}`);
    }
  }

  const nextFiles = Object.fromEntries(
    sources.map((source) => [source.relativePath, source.sha256]),
  );
  const nextMarker = {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    integration,
    version: VERSION,
    files: nextFiles,
  };
  const currentFilesMatch = await allFilesMatch(target, nextFiles);
  const markerMatches = existingMarker && stableJson(existingMarker) === stableJson(nextMarker);
  if (currentFilesMatch && markerMatches) {
    return { integration, label: definition.label, status: "unchanged", target };
  }

  const status = existingMarker ? "updated" : "installed";
  if (dryRun) {
    return {
      integration,
      label: definition.label,
      status: existingMarker ? "would-update" : "would-install",
      target,
    };
  }

  await mkdir(target, { mode: 0o755, recursive: true });
  await assertNoSymlinkComponents(base, target);
  for (const source of sources) {
    const destination = resolve(target, source.relativePath);
    await mkdir(dirname(destination), { mode: 0o755, recursive: true });
    await assertNoSymlinkComponents(base, dirname(destination));
    await writeAtomic(
      destination,
      source.contents,
      source.relativePath.endsWith(".mjs") ? 0o755 : 0o644,
    );
  }

  if (existingMarker) {
    const obsolete = Object.keys(existingMarker.files).filter((file) => !(file in nextFiles));
    for (const relativePath of obsolete) {
      const destination = safeManagedPath(target, relativePath);
      if (await optionalLstat(destination)) await unlink(destination);
    }
  }

  await writeAtomic(markerPath, `${stableJson(nextMarker)}\n`, 0o644);
  return { integration, label: definition.label, status, target };
}

async function uninstallIntegration({ base, definition, dryRun, force, integration, target }) {
  await assertNoSymlinkComponents(base, target);
  const targetStat = await optionalLstat(target);
  if (!targetStat) {
    return { integration, label: definition.label, status: "unchanged", target };
  }
  if (targetStat.isSymbolicLink()) throw new Error(`refusing symlink target: ${target}`);
  if (!targetStat.isDirectory()) throw new Error(`target is not a directory: ${target}`);

  const markerPath = join(target, MARKER_FILE);
  const marker = await readMarker(markerPath, integration);
  if (!marker) {
    throw new Error(`refusing to uninstall unmanaged ${definition.label} target: ${target}`);
  }
  await verifyManagedFiles(target, marker, force, definition.label);

  if (dryRun) {
    return { integration, label: definition.label, status: "would-uninstall", target };
  }

  const managedPaths = Object.keys(marker.files)
    .map((relativePath) => safeManagedPath(target, relativePath))
    .sort((left, right) => right.length - left.length);
  for (const managedPath of managedPaths) {
    const stat = await optionalLstat(managedPath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing non-regular managed path: ${managedPath}`);
    }
    await unlink(managedPath);
  }
  await unlink(markerPath);
  await pruneManagedDirectories(target, managedPaths);
  await pruneEmptyDirectories(target, base);
  return { integration, label: definition.label, status: "uninstalled", target };
}

async function readAllowedSources(repositoryRoot, definition) {
  const root = resolve(repositoryRoot);
  const sourceRoot = resolve(root, definition.sourceRoot);
  assertInside(root, sourceRoot, "integration source");
  const sources = [];

  for (const relativePath of definition.files) {
    const sourcePath = safeManagedPath(sourceRoot, relativePath);
    let handle;
    try {
      handle = await open(sourcePath, READ_ONLY_NOFOLLOW_FLAGS);
    } catch (error) {
      if (error?.code === "ELOOP" || error?.code === "EMLINK") {
        throw integrationSourceError(sourcePath);
      }
      throw error;
    }

    let contents;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw integrationSourceError(sourcePath);
      if (!SUPPORTS_NOFOLLOW) {
        const currentPathStat = await lstat(sourcePath);
        if (
          currentPathStat.isSymbolicLink() ||
          !currentPathStat.isFile() ||
          !sameFile(currentPathStat, stat)
        ) {
          throw integrationSourceError(sourcePath);
        }
      }
      contents = await handle.readFile();
    } finally {
      await handle.close();
    }
    sources.push({ contents, relativePath, sha256: sha256(contents) });
  }
  return sources;
}

async function readMarker(markerPath, integration) {
  const stat = await optionalLstat(markerPath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`integration marker must be a regular file: ${markerPath}`);
  }

  let value;
  try {
    value = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`invalid integration marker: ${markerPath}`);
  }
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    value?.owner !== OWNER ||
    value?.integration !== integration ||
    typeof value?.version !== "string" ||
    !isHashMap(value?.files)
  ) {
    throw new Error(`integration marker has unexpected ownership or schema: ${markerPath}`);
  }
  for (const relativePath of Object.keys(value.files)) safeRelativePath(relativePath);
  return value;
}

async function verifyManagedFiles(target, marker, force, label) {
  const changed = [];
  for (const [relativePath, expectedHash] of Object.entries(marker.files)) {
    const filePath = safeManagedPath(target, relativePath);
    const stat = await optionalLstat(filePath);
    if (!stat) {
      changed.push(relativePath);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing non-regular managed path: ${filePath}`);
    }
    if (sha256(await readFile(filePath)) !== expectedHash) changed.push(relativePath);
  }
  if (changed.length > 0 && !force) {
    throw new Error(
      `${label} integration has locally modified managed files (${changed.join(", ")}); use --force only after reviewing them`,
    );
  }
}

async function allFilesMatch(target, files) {
  for (const [relativePath, expectedHash] of Object.entries(files)) {
    const filePath = safeManagedPath(target, relativePath);
    const stat = await optionalLstat(filePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
    if (sha256(await readFile(filePath)) !== expectedHash) return false;
  }
  return true;
}

async function writeAtomic(destination, contents, mode) {
  const stat = await optionalLstat(destination);
  if (stat?.isSymbolicLink()) throw new Error(`refusing symlink destination: ${destination}`);
  if (stat && !stat.isFile()) throw new Error(`destination is not a regular file: ${destination}`);

  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const backup = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.backup`);
  const handle = await open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (await optionalLstat(temporary)) await unlink(temporary);
    throw error;
  }

  let backedUp = false;
  let placed = false;
  try {
    if (stat) {
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(temporary, destination);
    placed = true;
    await chmod(destination, mode);
    if (backedUp) await unlink(backup);
  } catch (error) {
    if (backedUp) {
      if (await optionalLstat(destination)) await unlink(destination);
      await rename(backup, destination);
    } else if (placed && (await optionalLstat(destination))) {
      await unlink(destination);
    }
    if (await optionalLstat(temporary)) await unlink(temporary);
    throw error;
  }
}

async function assertNoSymlinkComponents(base, target) {
  assertInside(base, target, "target");
  const components = relative(base, target).split(sep).filter(Boolean);
  let cursor = base;
  for (const component of components) {
    cursor = join(cursor, component);
    const stat = await optionalLstat(cursor);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink path component: ${cursor}`);
    if (cursor !== target && !stat.isDirectory()) {
      throw new Error(`path component is not a directory: ${cursor}`);
    }
  }
}

async function pruneEmptyDirectories(start, boundary) {
  let cursor = start;
  while (cursor !== boundary) {
    assertInside(boundary, cursor, "prune target");
    try {
      await rmdir(cursor);
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") return;
      throw error;
    }
    cursor = dirname(cursor);
  }
}

async function pruneManagedDirectories(target, managedPaths) {
  const directories = new Set();
  for (const managedPath of managedPaths) {
    let cursor = dirname(managedPath);
    while (cursor !== target) {
      assertInside(target, cursor, "managed directory");
      directories.add(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
    }
  }
}

async function resolveExistingDirectory(input, label) {
  const path = resolve(input);
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw new Error(`${label} path is not a directory: ${path}`);
  return realpath(path);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function safeManagedPath(root, relativePath) {
  safeRelativePath(relativePath);
  const path = resolve(root, relativePath);
  assertInside(root, path, "managed path");
  return path;
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    value.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new Error(`unsafe managed relative path: ${String(value)}`);
  }
}

function assertInside(base, target, label) {
  const value = relative(base, target);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} must remain inside ${base}: ${target}`);
  }
}

function isHashMap(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))
  );
}

function integrationSourceError(sourcePath) {
  return new Error(`integration source must be a regular file: ${sourcePath}`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

export const integrationConstants = {
  markerFile: MARKER_FILE,
  owner: OWNER,
  repositoryRoot: REPOSITORY_ROOT,
  version: VERSION,
};
