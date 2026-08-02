import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertIntakeEvalCases, runIntakeEvals } from "./evaluation.ts";

const path = resolve(process.cwd(), process.argv[2] ?? "evals/intake-cases.json");
const cases: unknown = JSON.parse(await readFile(path, "utf8"));
assertIntakeEvalCases(cases);
const report = runIntakeEvals(cases);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.score < 0.9) process.exitCode = 1;
