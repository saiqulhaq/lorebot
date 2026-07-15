/**
 * Process helpers for the sync subsystem. Unlike kb.ts's private helper,
 * these return stdout (the orchestrator needs shas, diffstats, symrefs) and
 * support timeouts and secret redaction on error output.
 */

export type RunResult = { stdout: string; stderr: string; exitCode: number }

export type RunOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Applied to stderr before it appears in thrown errors (token scrubbing). */
  redact?: (text: string) => string
}

export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, options.timeoutMs)
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)

  if (timedOut) {
    throw new Error(`${cmd[0]} timed out after ${options.timeoutMs}ms`)
  }
  return { stdout, stderr, exitCode }
}

/** Run git, throw on failure (with redacted stderr), return trimmed stdout. */
export async function git(args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(["git", ...args], options)
  if (result.exitCode !== 0) {
    const redact = options.redact ?? ((text: string) => text)
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${redact(result.stderr.trim())}`)
  }
  return result.stdout.trim()
}

/** Like git(), but failures return undefined instead of throwing. */
export async function tryGit(args: string[], options: RunOptions = {}): Promise<string | undefined> {
  try {
    return await git(args, options)
  } catch {
    return undefined
  }
}
