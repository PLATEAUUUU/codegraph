/** Shared git runner for requirement discovery and diff parsing. */

import { execFileSync } from 'child_process';

const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 10000,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  maxBuffer: 256 * 1024 * 1024,
};

/** Run git in `cwd`; return trimmed stdout, or null on any failure. */
export function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { ...GIT_OPTS, cwd }).trim();
  } catch {
    return null;
  }
}

/** Like runGit but returns stdout untrimmed; use when line numbers matter. */
export function runGitRaw(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { ...GIT_OPTS, cwd });
  } catch {
    return null;
  }
}
