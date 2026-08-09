import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const result = npmCli
  ? spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { encoding: "utf8", shell: false })
  : spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", shell: false });
if (result.error || result.status !== 0) {
  throw new Error(result.stderr || result.error?.message || "npm pack inspection failed");
}
const report = JSON.parse(result.stdout);
const files = report[0]?.files?.map((entry) => entry.path) ?? [];
const allowedRoots = ["dist/", "README.md", "LICENSE", "SECURITY.md", "package.json"];
const unexpected = files.filter((file) => !allowedRoots.some((root) => file === root || file.startsWith(root)));
if (unexpected.length > 0) throw new Error(`Unexpected files in npm artifact: ${unexpected.join(", ")}`);

const suspicious = files.filter((file) => /(?:^|\/)(?:\.env|.*\.sqlite3?|.*\.pem|.*\.key|pinboardd\.log)$/iu.test(file));
if (suspicious.length > 0) throw new Error(`Sensitive-looking files in npm artifact: ${suspicious.join(", ")}`);

// A publish or pack without a prior build would ship a tarball that only
// contains metadata (README, LICENSE, package.json) and no runnable CLI.
// The allowlist above cannot detect that, so require the compiled entrypoint
// and at least one real module to be present.
const compiled = files.filter((file) => file.startsWith("dist/"));
if (compiled.length === 0) throw new Error("npm artifact contains no compiled dist/ output; the CLI would be unusable");
if (!files.includes("dist/cli.js")) throw new Error("npm artifact is missing the dist/cli.js entrypoint");
process.stdout.write(`Verified ${files.length} packaged files against the public allowlist (${compiled.length} compiled).\n`);
