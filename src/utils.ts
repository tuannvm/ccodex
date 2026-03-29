import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join, delimiter, isAbsolute, resolve, sep } from "path";
import spawnCmd from "cross-spawn";
import { execSync } from "child_process";
import { spawn } from "child_process";
import type { Platform } from "./types.js";

/**
 * Debug logging helper
 */
export function debugLog(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG || process.env.CCODEX_DEBUG) {
    console.error(`[ccodex debug] ${message}`, ...args);
  }
}

/**
 * Execute a command and return stdout
 */
export async function execCommand(
  cmd: string,
  args: string[] = [],
  timeoutMs = 10000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCmd(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Add timeout to prevent hangs
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);

    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`));
      }
    });

    child.on("error", (error: unknown) => {
      clearTimeout(timeout);
      const err = error instanceof Error ? error : new Error(String(error));
      reject(err);
    });
  });
}

/**
 * Resolve executable path from PATH without spawning the command.
 * Returns absolute/relative executable path if found, otherwise null.
 */
export function resolveCommandPath(cmd: string): string | null {
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(delimiter).filter(Boolean);

  // If cmd already has a path separator, test directly
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }

  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);

    const hasKnownExt = pathext.some((ext) => cmd.toUpperCase().endsWith(ext.toUpperCase()));
    const candidates = hasKnownExt ? [cmd] : [cmd, ...pathext.map((ext) => `${cmd}${ext}`)];

    for (const dir of pathDirs) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate);
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }

    return null;
  }

  for (const dir of pathDirs) {
    const fullPath = join(dir, cmd);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Cross-platform command existence check using PATH resolution.
 * Avoids spawning `<cmd> --version` (which is unreliable on Windows).
 */
export async function hasCommand(cmd: string): Promise<boolean> {
  try {
    return resolveCommandPath(cmd) !== null;
  } catch (error) {
    debugLog(`hasCommand failed for ${cmd}:`, error);
    return false;
  }
}

/**
 * Return full resolved command path from PATH if available.
 */
export async function getCommandPath(cmd: string): Promise<string | null> {
  try {
    const resolved = resolveCommandPath(cmd);
    return resolved;
  } catch (error) {
    debugLog(`getCommandPath failed for ${cmd}:`, error);
    return null;
  }
}

/**
 * Detect current platform
 * Throws on unsupported platforms
 */
export function detectPlatform(): Platform {
  const osPlatform = platform();
  let os: "darwin" | "linux" | "windows";

  // Explicitly handle supported platforms
  if (osPlatform === "darwin") {
    os = "darwin";
  } else if (osPlatform === "linux") {
    os = "linux";
  } else if (osPlatform === "win32") {
    os = "windows";
  } else {
    throw new Error(
      `Unsupported platform: ${osPlatform}. ccodex supports darwin, linux, and win32.`
    );
  }

  // Detect shell
  let shell: "zsh" | "bash" | "cmd" | "powershell" | null = null;
  const shellEnv = process.env.SHELL || "";

  if (shellEnv.includes("zsh")) {
    shell = "zsh";
  } else if (shellEnv.includes("bash")) {
    shell = "bash";
  } else if (os === "windows") {
    shell = process.env.PSModulePath ? "powershell" : "cmd";
  }

  return {
    os,
    shell,
    home: homedir(),
  };
}

/**
 * Get shell rc file path
 * Returns appropriate config file based on platform and shell
 */
export function getShellRcFile(platform: Platform): string {
  if (platform.os === "windows") {
    // Windows doesn't use rc files the same way
    // Return a placeholder path for documentation purposes
    return join(platform.home, ".ccodex-config.ps1");
  }

  if (platform.shell === "zsh") {
    return join(platform.home, ".zshrc");
  } else if (platform.shell === "bash") {
    return join(platform.home, ".bashrc");
  }
  return join(platform.home, ".zshrc"); // default to zsh on Unix
}

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make HTTP GET request with timeout
 */
export async function httpGet(
  url: string,
  timeoutMs = 30000
): Promise<{ status: number; body: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const body = await response.text();
      return {
        status: response.status,
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    debugLog(`httpGet failed for ${url}:`, error);
    throw error;
  }
}

/**
 * Safe JSON parse with runtime validation
 * Returns null if parsing fails or if result doesn't match expected structure
 */
export function safeJsonParse<T>(
  str: string,
  validator?: (value: unknown) => value is T
): T | null {
  try {
    const parsed = JSON.parse(str);

    // If validator provided, use it for runtime type checking
    if (validator) {
      return validator(parsed) ? parsed : null;
    }

    // Without validator, return as unknown cast to T
    // Caller is responsible for validation
    return parsed as T;
  } catch (error) {
    debugLog("safeJsonParse failed:", str.substring(0, 100), error);
    return null;
  }
}

/**
 * Check if running in terminal
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY;
}

/**
 * Check if file exists
 */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Ensure directory exists
 */
export async function ensureDir(path: string): Promise<void> {
  const fs = await import("fs/promises");
  try {
    await fs.mkdir(path, { recursive: true });
  } catch (error) {
    debugLog(`ensureDir failed for ${path}:`, error);
    throw error;
  }
}

/**
 * Read file content
 */
export async function readFile(path: string): Promise<string> {
  const fs = await import("fs/promises");
  return await fs.readFile(path, "utf-8");
}

/**
 * Write file content
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const fs = await import("fs/promises");
  await fs.writeFile(path, content, "utf-8");
}

/**
 * Append to file
 */
export async function appendFile(path: string, content: string): Promise<void> {
  const fs = await import("fs/promises");
  await fs.appendFile(path, content, "utf-8");
}

/**
 * Make file executable
 * Only applies chmod on Unix/macOS; no-op on Windows
 */
export async function makeExecutable(path: string): Promise<void> {
  const fs = await import("fs/promises");

  // chmod doesn't work on Windows the same way
  if (process.platform === "win32") {
    debugLog(`Skipping chmod on Windows for ${path}`);
    return;
  }

  const mode = 0o755;
  try {
    await fs.chmod(path, mode);
  } catch (error) {
    debugLog(`makeExecutable failed for ${path}:`, error);
    // Don't throw - file permission issues shouldn't break the flow
  }
}

/**
 * Copy file
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const fs = await import("fs/promises");
  await fs.copyFile(src, dest);
}

/**
 * Get user ID (cross-platform)
 */
export function getUid(): number {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  // Fallback for Windows - use a sensible default
  // On Windows, we'd typically use username or SID instead
  return 1000;
}

/**
 * Get allowed installation directories for system commands
 * Returns paths that are considered safe sources for tar/brew/npm
 */
function getTrustedCommandDirs(): string[] {
  const home = homedir();
  const allowed: string[] = [
    "/usr/bin", // Standard system bin
    "/usr/local/bin", // System local bin
    "/bin", // Core system bin
    "/opt/homebrew/bin", // Homebrew Apple Silicon
    "/usr/local/bin", // Homebrew Intel
    "/opt/homebrew", // Homebrew base
    "/usr/local", // Local software base
  ];

  // Add user-local paths
  if (home) {
    allowed.push(
      join(home, ".local", "bin"),
      join(home, ".npm", "global", "bin"),
      join(home, "node_modules", ".bin")
    );
  }

  return allowed;
}

/**
 * Validate that a command path is from a trusted directory
 * Throws if path is not absolute or not from allowed directory
 */
function validateCommandPath(cmd: string, cmdPath: string): void {
  if (!isAbsolute(cmdPath)) {
    throw new Error(`${cmd} path is not absolute: ${cmdPath}`);
  }

  const realPath = resolve(cmdPath);
  const allowedDirs = getTrustedCommandDirs();

  const isAllowed = allowedDirs.some((allowedDir) => {
    const resolvedAllowed = resolve(allowedDir);
    return realPath.startsWith(resolvedAllowed + sep) || realPath === resolvedAllowed;
  });

  if (!isAllowed) {
    throw new Error(
      `${cmd} binary not from trusted location.\n` +
        `Path: ${realPath}\n` +
        `Allowed directories: ${allowedDirs.join(", ")}\n\n` +
        `For security, only commands from trusted locations are executed.\n` +
        `If you installed ${cmd} manually, move it to a trusted directory.`
    );
  }
}

/**
 * Resolve and validate trusted command path
 * Ensures the command is from a trusted directory before use
 */
export async function requireTrustedCommand(cmd: "tar" | "brew" | "npm"): Promise<string> {
  const p = await getCommandPath(cmd);
  if (!p || !isAbsolute(p)) {
    throw new Error(`${cmd} not found as absolute path in PATH`);
  }
  validateCommandPath(cmd, p);
  return p;
}

/**
 * Run a command with bounded execution time and output caps
 * Prevents DoS via long-running commands or excessive output
 */
export async function runCmdBounded(
  cmd: string,
  args: string[],
  timeoutMs = 15000,
  maxOut = 1_000_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // Platform-aware termination: SIGKILL on Unix, default kill on Windows
      if (process.platform === "win32") {
        cp.kill(); // Windows: uses default termination
      } else {
        cp.kill("SIGKILL"); // Unix: force kill
      }
    }, timeoutMs);

    cp.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < maxOut) {
        stdout += d.toString();
      }
    });
    cp.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < maxOut) {
        stderr += d.toString();
      }
    });

    cp.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    cp.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timeout after ${timeoutMs}ms: ${cmd}`));
      } else {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

/**
 * Install lock file manager
 * Prevents concurrent installs from corrupting state
 */
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const INSTALL_LOCK_MAX_WAIT_MS = 30 * 1000; // 30 seconds

/**
 * Check if a process with given PID is alive
 * Returns false if PID doesn't exist, true if possibly alive
 */
function isPidAlive(pid: number): boolean {
  if (process.platform === "win32") {
    // On Windows, use tasklist to check if process exists
    try {
      const result = execSync(`tasklist /FI "PID eq ${pid}" 2>nul`, { encoding: "utf8" });
      return result.includes(String(pid));
    } catch {
      return false;
    }
  }
  // Unix: use kill(pid, 0) to check liveness (no signal sent)
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withInstallLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const fs = await import("fs/promises");
  const start = Date.now();

  while (true) {
    try {
      // Try to create lock file exclusively
      const fh = await fs.open(lockPath, "wx");
      // Write PID and timestamp
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      try {
        // Run the critical section
        return await fn();
      } finally {
        // Always release lock
        await fh.close();
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (e: any) {
      // Lock file exists
      if (e?.code !== "EEXIST") throw e;

      // Read lock file to check PID
      const lockContent = await fs.readFile(lockPath, "utf-8").catch(() => null);
      let lockData: { pid: number; ts: number } | null = null;
      if (lockContent) {
        try {
          lockData = JSON.parse(lockContent) as { pid: number; ts: number };
        } catch {
          // Malformed lock file - treat as invalid/stale
          debugLog("Lock file contains invalid JSON, treating as stale");
          lockData = null;
        }
      }

      // Check if lock is stale AND PID is not alive
      const st = await fs.stat(lockPath).catch(() => null);
      if (st && Date.now() - st.mtimeMs > INSTALL_LOCK_STALE_MS) {
        // Verify PID is actually dead before stealing lock
        if (!lockData || !isPidAlive(lockData.pid)) {
          // Safe to remove stale lock
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        // PID is still alive, respect the lock even if old
      }

      // Check timeout
      if (Date.now() - start > INSTALL_LOCK_MAX_WAIT_MS) {
        throw new Error("Timed out waiting for install lock. Another install may be in progress.");
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
