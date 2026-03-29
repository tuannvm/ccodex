import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import spawnCmd from 'cross-spawn';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Platform } from './types.js';

const exec = promisify(execCallback);

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
export async function execCommand(cmd: string, args: string[] = [], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCmd(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Add timeout to prevent hangs
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);

    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`));
      }
    });

    child.on('error', (error: unknown) => {
      clearTimeout(timeout);
      const err = error instanceof Error ? error : new Error(String(error));
      reject(err);
    });
  });
}

/**
 * Cross-platform command existence check
 * Uses Node.js built-in where command on Unix, falls back to PATH search on Windows
 */
export async function hasCommand(cmd: string): Promise<boolean> {
  try {
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      // On Windows, try to spawn the command with --version only
      // Use short timeout to avoid hangs on interactive commands
      try {
        await execCommand(cmd, ['--version'], 3000);
        return true;
      } catch {
        return false;
      }
    } else {
      // On Unix/macOS, use the which command
      await execCommand('which', [cmd]);
      return true;
    }
  } catch (error) {
    debugLog(`hasCommand failed for ${cmd}:`, error);
    return false;
  }
}

/**
 * Detect current platform
 * Throws on unsupported platforms
 */
export function detectPlatform(): Platform {
  const osPlatform = platform();
  let os: 'darwin' | 'linux' | 'windows';

  // Explicitly handle supported platforms
  if (osPlatform === 'darwin') {
    os = 'darwin';
  } else if (osPlatform === 'linux') {
    os = 'linux';
  } else if (osPlatform === 'win32') {
    os = 'windows';
  } else {
    throw new Error(`Unsupported platform: ${osPlatform}. ccodex supports darwin, linux, and win32.`);
  }

  // Detect shell
  let shell: 'zsh' | 'bash' | 'cmd' | 'powershell' | null = null;
  const shellEnv = process.env.SHELL || '';

  if (shellEnv.includes('zsh')) {
    shell = 'zsh';
  } else if (shellEnv.includes('bash')) {
    shell = 'bash';
  } else if (os === 'windows') {
    shell = process.env.PSModulePath ? 'powershell' : 'cmd';
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
  if (platform.os === 'windows') {
    // Windows doesn't use rc files the same way
    // Return a placeholder path for documentation purposes
    return join(platform.home, '.ccodex-config.ps1');
  }

  if (platform.shell === 'zsh') {
    return join(platform.home, '.zshrc');
  } else if (platform.shell === 'bash') {
    return join(platform.home, '.bashrc');
  }
  return join(platform.home, '.zshrc'); // default to zsh on Unix
}

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make HTTP GET request
 */
export async function httpGet(url: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url);
    const body = await response.text();
    return {
      status: response.status,
      body,
    };
  } catch (error) {
    debugLog(`httpGet failed for ${url}:`, error);
    throw error;
  }
}

/**
 * Safe JSON parse with runtime validation
 * Returns null if parsing fails or if result doesn't match expected structure
 */
export function safeJsonParse<T>(str: string, validator?: (value: unknown) => value is T): T | null {
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
    debugLog('safeJsonParse failed:', str.substring(0, 100), error);
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
  const fs = await import('fs/promises');
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
  const fs = await import('fs/promises');
  return await fs.readFile(path, 'utf-8');
}

/**
 * Write file content
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const fs = await import('fs/promises');
  await fs.writeFile(path, content, 'utf-8');
}

/**
 * Append to file
 */
export async function appendFile(path: string, content: string): Promise<void> {
  const fs = await import('fs/promises');
  await fs.appendFile(path, content, 'utf-8');
}

/**
 * Make file executable
 * Only applies chmod on Unix/macOS; no-op on Windows
 */
export async function makeExecutable(path: string): Promise<void> {
  const fs = await import('fs/promises');

  // chmod doesn't work on Windows the same way
  if (process.platform === 'win32') {
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
  const fs = await import('fs/promises');
  await fs.copyFile(src, dest);
}

/**
 * Get user ID (cross-platform)
 */
export function getUid(): number {
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }
  // Fallback for Windows - use a sensible default
  // On Windows, we'd typically use username or SID instead
  return 1000;
}
