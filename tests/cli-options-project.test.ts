import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { helpText, parseCliOptions } from "../src/cli-options.ts";
import { discoverVerificationCommands, inspectProject } from "../src/project-context.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "super-router-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(path: string, contents = ""): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI option parsing", () => {
  test("treats a bare prompt as the run command", () => {
    const result = parseCliOptions(["Fix", "the", "API"], "/workspace");
    expect(result).toMatchObject({
      command: "run",
      prompt: "Fix the API",
      cwd: "/workspace",
      dryRun: false,
      explain: false,
      json: false,
      memoryEnabled: true,
      skills: [],
    });
  });

  test("makes plan dry-run and explanatory by default", () => {
    const result = parseCliOptions(["plan", "Design a secure API"]);
    expect(result.command).toBe("plan");
    expect(result.prompt).toBe("Design a secure API");
    expect(result.dryRun).toBe(true);
    expect(result.explain).toBe(true);
  });

  test("parses all route, budget, safety, output, and repeated skill overrides", () => {
    const result = parseCliOptions([
      "run",
      "--cwd",
      "/repo",
      "--config",
      "/repo/config.json",
      "--provider",
      "codex",
      "--prefer-provider",
      "claude-code",
      "--model",
      "gpt-x",
      "--effort",
      "deep",
      "--agent",
      "reviewer",
      "--skill",
      "security",
      "--skill",
      "testing",
      "--quality-floor",
      "0.93",
      "--max-cost",
      "1.25",
      "--max-input-tokens",
      "12000",
      "--max-output-tokens",
      "3000",
      "--max-duration-ms",
      "60000",
      "--dry-run",
      "--explain",
      "--json",
      "--allow-external-writes",
      "--allow-destructive",
      "--trust-project",
      "--no-memory",
      "Implement",
      "the endpoint",
    ]);

    expect(result).toEqual({
      command: "run",
      prompt: "Implement the endpoint",
      cwd: "/repo",
      configPath: "/repo/config.json",
      dryRun: true,
      explain: true,
      json: true,
      allowExternalWrites: true,
      allowDestructiveActions: true,
      trustProject: true,
      memoryEnabled: false,
      preferredProvider: "claude-code",
      provider: "codex",
      model: "gpt-x",
      effort: "deep",
      agent: "reviewer",
      skills: ["security", "testing"],
      qualityFloor: 0.93,
      maxCostUsd: 1.25,
      maxInputTokens: 12_000,
      maxOutputTokens: 3_000,
      maxDurationMs: 60_000,
    });
  });

  test.each(["doctor", "capabilities", "stats", "help", "version"] as const)(
    "accepts prompt-free %s command",
    (command) => {
      expect(parseCliOptions([command]).command).toBe(command);
    },
  );

  test("supports global help and version aliases", () => {
    expect(parseCliOptions(["--help"]).command).toBe("help");
    expect(parseCliOptions(["--version"]).command).toBe("version");
    expect(helpText).toContain("Minimum predicted and verified quality");
    expect(helpText).toContain("--allow-destructive");
    expect(helpText).toContain("--trust-project");
    expect(helpText).toContain("--prefer-provider");
    expect(helpText).toContain("disable cross-provider fallback");
  });

  test.each([
    [[], "run requires a task prompt"],
    [["plan"], "plan requires a task prompt"],
    [["run", "--model"], "--model requires a value"],
    [["run", "--effort", "turbo", "task"], "--effort must be economy"],
    [["run", "--quality-floor", "1.1", "task"], "--quality-floor cannot exceed 1"],
    [["run", "--quality-floor", "0", "task"], "--quality-floor must be greater than zero"],
    [["run", "--max-cost", "NaN", "task"], "--max-cost must be greater than zero"],
    [["run", "--unknown", "task"], "Unknown option: --unknown"],
  ] as const)("rejects malformed argv %o", (argv, message) => {
    expect(() => parseCliOptions([...argv])).toThrow(message);
  });

  test("recognizes integrations instead of treating it as a run prompt", () => {
    const options = parseCliOptions(["integrations", "install", "--all", "--scope", "user"]);
    expect(options.command).toBe("integrations");
    expect(options.prompt).toBe("");
  });

  test("passes installer flags through without router option parsing", () => {
    // `--all`, `--project-dir`, and `--force` belong to the installer. Before the
    // command was recognized, argv fell through to the `run` alias and these
    // raised `Unknown option`.
    for (const flag of ["--all", "--codex", "--claude-code", "--force", "--dry-run"]) {
      expect(() => parseCliOptions(["integrations", "install", flag])).not.toThrow();
    }
    expect(() =>
      parseCliOptions(["integrations", "install", "--scope", "project", "--project-dir", "/tmp/x"]),
    ).not.toThrow();
  });

  test("help text points source checkouts at the installer script", () => {
    expect(helpText).toContain("node scripts/install-integrations.mjs");
  });
});

describe("project-aware verification discovery", () => {
  test("prefers one package check command and detects Bun", async () => {
    const directory = await temporaryDirectory();
    await createFile(join(directory, "bun.lock"));
    await createFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: { check: "bun run typecheck && bun test", test: "bun test" },
      }),
    );
    expect(discoverVerificationCommands(directory)).toEqual(["bun run check"]);
  });

  test.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    [undefined, "npm"],
  ] as const)("detects %s package runner", async (lockfile, runner) => {
    const directory = await temporaryDirectory();
    if (lockfile) await createFile(join(directory, lockfile));
    await createFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "lint", test: "test", build: "build" } }),
    );
    expect(discoverVerificationCommands(directory)).toEqual([
      `${runner} run typecheck`,
      `${runner} run lint`,
      `${runner} run test`,
      `${runner} run build`,
    ]);
  });

  test("falls back to native ecosystem checks in deterministic priority", async () => {
    const cargo = await temporaryDirectory();
    await createFile(join(cargo, "Cargo.toml"));
    await createFile(join(cargo, "go.mod"));
    expect(discoverVerificationCommands(cargo)).toEqual(["cargo test", "cargo clippy"]);

    const go = await temporaryDirectory();
    await createFile(join(go, "go.mod"));
    expect(discoverVerificationCommands(go)).toEqual(["go test ./..."]);

    const python = await temporaryDirectory();
    await createFile(join(python, "pyproject.toml"));
    expect(discoverVerificationCommands(python)).toEqual(["pytest"]);
  });

  test("treats malformed or scriptless package metadata as no checks", async () => {
    const malformed = await temporaryDirectory();
    await createFile(join(malformed, "package.json"), "{not-json");
    expect(discoverVerificationCommands(malformed)).toEqual([]);

    const scriptless = await temporaryDirectory();
    await createFile(join(scriptless, "package.json"), JSON.stringify({ scripts: ["test"] }));
    expect(discoverVerificationCommands(scriptless)).toEqual([]);
  });

  test("fails safely for oversized and symbolic-link package metadata", async () => {
    const oversized = await temporaryDirectory();
    await createFile(
      join(oversized, "package.json"),
      JSON.stringify({
        scripts: { check: "must not be discovered" },
        padding: "x".repeat(1024 * 1024),
      }),
    );
    expect(discoverVerificationCommands(oversized)).toEqual([]);

    const linked = await temporaryDirectory();
    await createFile(
      join(linked, "real-package.json"),
      JSON.stringify({ scripts: { check: "must not be discovered" } }),
    );
    await symlink("real-package.json", join(linked, "package.json"));
    expect(discoverVerificationCommands(linked)).toEqual([]);
  });

  test("builds a stable project identity outside Git and returns absolute paths", async () => {
    const directory = await temporaryDirectory();
    const nested = join(directory, "nested");
    await mkdir(nested);
    const first = inspectProject(nested);
    const second = inspectProject(nested);

    expect(first.cwd).toBe(resolve(nested));
    expect(isAbsolute(first.cwd)).toBe(true);
    expect(first.projectId).toHaveLength(24);
    expect(first.projectId).toBe(second.projectId);
    expect(first.branch).toBeUndefined();
    expect(first.commit).toBeUndefined();
    expect(first.verificationCommands).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "bounds Git probe output and duration and falls back safely",
    async () => {
      const directory = await temporaryDirectory();
      const workspace = join(directory, "workspace");
      const binaryDirectory = join(directory, "bin");
      await mkdir(workspace);
      await mkdir(binaryDirectory);
      const fakeGit = join(binaryDirectory, "git");
      await writeFile(
        fakeGit,
        [
          "#!/usr/bin/env node",
          'const rootProbe = process.argv[2] === "rev-parse" && process.argv[3] === "--show-toplevel";',
          "if (!rootProbe) process.exit(1);",
          'if (process.env.SUPER_ROUTER_TEST_GIT_MODE === "oversized") {',
          '  process.stdout.write("x".repeat(70_000));',
          "} else {",
          "  setTimeout(() => process.exit(0), 10_000);",
          "}",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeGit, 0o755);

      const projectContextPath = resolve(import.meta.dir, "../src/project-context.ts");
      const inspectScript = [
        `const { inspectProject } = await import(${JSON.stringify(projectContextPath)});`,
        `process.stdout.write(JSON.stringify(inspectProject(${JSON.stringify(workspace)})));`,
      ].join("\n");
      const runProbe = (mode: "oversized" | "timeout") =>
        spawnSync(process.execPath, ["-e", inspectScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
            SUPER_ROUTER_TEST_GIT_MODE: mode,
          },
          shell: false,
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });

      for (const mode of ["oversized", "timeout"] as const) {
        const startedAt = Date.now();
        const result = runProbe(mode);
        expect(result.status).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(4_000);
        const inspected = JSON.parse(result.stdout) as ReturnType<typeof inspectProject>;
        expect(inspected.cwd).toBe(resolve(workspace));
        expect(inspected.branch).toBeUndefined();
        expect(inspected.commit).toBeUndefined();
      }
    },
    10_000,
  );

  test("isolates state namespaces for distinct clones with the same remote", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    for (const directory of [first, second]) {
      const init = spawnSync("git", ["init", "-q"], { cwd: directory, shell: false });
      if (init.status !== 0) throw new Error("git init fixture failed");
      const remote = spawnSync(
        "git",
        ["remote", "add", "origin", "git@github.com:example/shared.git"],
        { cwd: directory, shell: false },
      );
      if (remote.status !== 0) throw new Error("git remote fixture failed");
    }

    expect(inspectProject(first).projectId).not.toBe(inspectProject(second).projectId);
  });
});
