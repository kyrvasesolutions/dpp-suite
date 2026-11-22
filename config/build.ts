import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The commit the build is made from: GITHUB_SHA in CI, else git, else "unknown" outside a repository. */
export function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Compile-time constants for the software version of every output (package.json version plus the commit). */
export function buildDefines(commit = buildCommit()) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  return { __APP_VERSION__: JSON.stringify(version), __BUILD_COMMIT__: JSON.stringify(commit) };
}
