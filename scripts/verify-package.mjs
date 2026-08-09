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
process.stdout.write(`Verified ${files.length} packaged files against the public allowlist.\n`);
