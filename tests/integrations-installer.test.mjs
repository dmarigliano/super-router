import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseInstallerArguments } from "../scripts/install-integrations.mjs";
import { integrationConstants, runIntegrationCommand } from "../scripts/integrations/installer.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("native integration installer", () => {
  test("installs, updates idempotently, and uninstalls both user integrations", async () => {
    const homeDir = await temporaryDirectory();
    const options = {
      action: "install",
      integrations: ["codex", "claude-code"],
      scope: "user",
      homeDir,
    };

    const installed = await runIntegrationCommand(options);
    expect(installed.map((result) => result.status)).toEqual(["installed", "installed"]);

    const codexTarget = join(homeDir, ".agents", "skills", "super-router");
    const claudeTarget = join(homeDir, ".claude", "skills", "super-router");
    expect(await fileExists(join(codexTarget, "SKILL.md"))).toBe(true);
    expect(await fileExists(join(codexTarget, "agents", "openai.yaml"))).toBe(true);
    expect(await fileExists(join(claudeTarget, "SKILL.md"))).toBe(true);
    expect(await fileExists(join(claudeTarget, "scripts", "invoke.mjs"))).toBe(true);

    const marker = JSON.parse(
      await readFile(join(codexTarget, integrationConstants.markerFile), "utf8"),
    );
    expect(marker.owner).toBe("@dmarigliano/super-router");
    expect(Object.keys(marker.files).sort()).toEqual([
      "SKILL.md",
      "agents/openai.yaml",
      "scripts/invoke.mjs",
    ]);

    const unchanged = await runIntegrationCommand(options);
    expect(unchanged.map((result) => result.status)).toEqual(["unchanged", "unchanged"]);

    const removed = await runIntegrationCommand({ ...options, action: "uninstall" });
    expect(removed.map((result) => result.status)).toEqual(["uninstalled", "uninstalled"]);
    expect(await fileExists(codexTarget)).toBe(false);
    expect(await fileExists(claudeTarget)).toBe(false);
  });

  test("dry-run does not create a target", async () => {
    const homeDir = await temporaryDirectory();
    const [result] = await runIntegrationCommand({
      action: "install",
      integrations: ["codex"],
      scope: "user",
      homeDir,
      dryRun: true,
    });

    expect(result.status).toBe("would-install");
    expect(await fileExists(result.target)).toBe(false);
  });

  test("refuses unmanaged collisions and symlink path components", async () => {
    const homeDir = await temporaryDirectory();
    const codexTarget = join(homeDir, ".agents", "skills", "super-router");
    await mkdir(codexTarget, { recursive: true });
    await writeFile(join(codexTarget, "SKILL.md"), "user-owned\n");

    await expect(
      runIntegrationCommand({
        action: "install",
        integrations: ["codex"],
        scope: "user",
        homeDir,
      }),
    ).rejects.toThrow("unmanaged files");

    const symlinkHome = await temporaryDirectory();
    const redirected = join(symlinkHome, "redirected");
    await mkdir(redirected);
    await symlink(redirected, join(symlinkHome, ".agents"));
    await expect(
      runIntegrationCommand({
        action: "install",
        integrations: ["codex"],
        scope: "user",
        homeDir: symlinkHome,
      }),
    ).rejects.toThrow("symlink path component");
  });

  test("refuses symlinked integration source files", async () => {
    const repositoryRoot = await temporaryDirectory();
    const sourceRoot = join(repositoryRoot, "integrations", "codex", "skills", "super-router");
    await mkdir(join(sourceRoot, "agents"), { recursive: true });
    await mkdir(join(sourceRoot, "scripts"), { recursive: true });
    const redirectedSkill = join(repositoryRoot, "redirected-skill.md");
    await writeFile(redirectedSkill, "redirected\n");
    await symlink(redirectedSkill, join(sourceRoot, "SKILL.md"), "file");
    await writeFile(join(sourceRoot, "agents", "openai.yaml"), "interface: {}\n");
    await writeFile(join(sourceRoot, "scripts", "invoke.mjs"), "export {};\n");

    await expect(
      runIntegrationCommand({
        action: "install",
        integrations: ["codex"],
        scope: "user",
        homeDir: repositoryRoot,
        repositoryRoot,
      }),
    ).rejects.toThrow("integration source must be a regular file");
  });

  test("protects modified managed files and preserves unowned files on forced uninstall", async () => {
    const homeDir = await temporaryDirectory();
    const options = {
      action: "install",
      integrations: ["claude-code"],
      scope: "user",
      homeDir,
    };
    await runIntegrationCommand(options);

    const target = join(homeDir, ".claude", "skills", "super-router");
    const skill = join(target, "SKILL.md");
    const unowned = join(target, "notes.txt");
    await writeFile(skill, "locally modified\n");
    await writeFile(unowned, "preserve me\n");

    await expect(runIntegrationCommand({ ...options, action: "uninstall" })).rejects.toThrow(
      "locally modified managed files",
    );

    const [result] = await runIntegrationCommand({
      ...options,
      action: "uninstall",
      force: true,
    });
    expect(result.status).toBe("uninstalled");
    expect(await readFile(unowned, "utf8")).toBe("preserve me\n");
    expect(await fileExists(skill)).toBe(false);
  });
});

describe("integration command wrappers", () => {
  test("passes objectives literally and adds trust to every run mode", async () => {
    const directory = await temporaryDirectory();
    const binaryDirectory = join(directory, "bin");
    const capturePath = join(directory, "capture.json");
    const sideEffectPath = join(directory, "must-not-exist");
    await mkdir(binaryDirectory);
    const fakeBinary = join(binaryDirectory, "super-router");
    await writeFile(
      fakeBinary,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.SUPER_ROUTER_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n',
    );
    await chmod(fakeBinary, 0o755);

    const codexWrapper = join(
      integrationConstants.repositoryRoot,
      "integrations",
      "codex",
      "skills",
      "super-router",
      "scripts",
      "invoke.mjs",
    );
    const claudeWrapper = join(
      integrationConstants.repositoryRoot,
      "integrations",
      "claude-code",
      "standalone",
      "scripts",
      "invoke.mjs",
    );
    expect(await readFile(codexWrapper, "utf8")).toBe(await readFile(claudeWrapper, "utf8"));

    const objective = `review literally $(touch ${sideEffectPath})`;
    const environment = {
      ...process.env,
      PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
      SUPER_ROUTER_TEST_CAPTURE: capturePath,
    };

    expect(
      Bun.spawnSync(["node", codexWrapper, "run", "--", objective], { env: environment }).exitCode,
    ).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
      "run",
      "--trust-project",
      objective,
    ]);
    expect(await fileExists(sideEffectPath)).toBe(false);

    expect(
      Bun.spawnSync(["node", codexWrapper, "dry-run", "--", objective], { env: environment })
        .exitCode,
    ).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
      "run",
      "--dry-run",
      "--trust-project",
      objective,
    ]);

    expect(
      Bun.spawnSync(["node", codexWrapper, "plan", "--", objective], { env: environment }).exitCode,
    ).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
      "plan",
      "--explain",
      objective,
    ]);
  });
});

describe("installer argument parsing", () => {
  test("requires an explicit target and project root", () => {
    expect(() => parseInstallerArguments(["install"])).toThrow("choose");
    expect(() => parseInstallerArguments(["install", "--codex", "--scope", "project"])).toThrow(
      "--project-dir",
    );
    expect(parseInstallerArguments(["install", "--all", "--dry-run"])).toEqual({
      action: "install",
      integrations: ["codex", "claude-code"],
      scope: "user",
      dryRun: true,
      force: false,
    });
  });
});

describe("packaged binary dispatch", () => {
  test("routes the integrations command to the safe installer", async () => {
    const projectDir = await temporaryDirectory();
    const binary = join(integrationConstants.repositoryRoot, "bin", "super-router.js");

    const install = Bun.spawnSync([
      "node",
      binary,
      "integrations",
      "install",
      "--claude-code",
      "--scope",
      "project",
      "--project-dir",
      projectDir,
    ]);
    expect(install.exitCode).toBe(0);
    expect(
      await fileExists(join(projectDir, ".claude", "skills", "super-router", "SKILL.md")),
    ).toBe(true);

    const uninstall = Bun.spawnSync([
      "node",
      binary,
      "integrations",
      "uninstall",
      "--claude-code",
      "--scope",
      "project",
      "--project-dir",
      projectDir,
    ]);
    expect(uninstall.exitCode).toBe(0);
    expect(await fileExists(join(projectDir, ".claude", "skills", "super-router"))).toBe(false);
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "super-router-integrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
