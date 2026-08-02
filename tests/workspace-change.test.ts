import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/adapters/process-runner.ts";
import { BoundedWorkspaceChangeDetector } from "../src/runtime/workspace-change.ts";

const temporaryDirectories: string[] = [];

const nonGitRunner: ProcessRunner = {
  run: async () => ({
    stdout: "",
    stderr: "not a git repository",
    exitCode: 128,
    signal: null,
    durationMs: 1,
    timedOut: false,
  }),
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded workspace filesystem fingerprint", () => {
  test("hashes regular-file content and observes same-size changes", async () => {
    const workspace = await temporaryDirectory("super-router-workspace-");
    const path = join(workspace, "artifact.txt");
    const detector = new BoundedWorkspaceChangeDetector({ runner: nonGitRunner });
    await writeFile(path, "before", "utf8");

    const before = await detector.fingerprint(workspace);
    await writeFile(path, "after!", "utf8");
    const after = await detector.fingerprint(workspace);

    expect(before.complete).toBe(true);
    expect(before.filesInspected).toBe(1);
    expect(before.bytesHashed).toBe(6);
    expect(after.digest).not.toBe(before.digest);
  });

  test("hashes a symlink itself without reading an outside target", async () => {
    const workspace = await temporaryDirectory("super-router-workspace-");
    const outside = await temporaryDirectory("super-router-outside-");
    const target = join(outside, "secret.txt");
    const link = join(workspace, "linked.txt");
    const detector = new BoundedWorkspaceChangeDetector({ runner: nonGitRunner });
    await writeFile(target, "first outside value", "utf8");
    await symlink(target, link);

    const before = await detector.fingerprint(workspace);
    await writeFile(target, "different outside value", "utf8");
    const after = await detector.fingerprint(workspace);

    expect(before.complete).toBe(true);
    expect(before.filesInspected).toBe(1);
    expect(before.bytesHashed).toBe(0);
    expect(after.digest).toBe(before.digest);
  });
});
