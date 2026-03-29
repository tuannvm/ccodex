import { join } from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { hasCommand, execCommand, httpGet, sleep, ensureDir, fileExists, safeJsonParse, debugLog } from './utils.js';
import { CONFIG, getProxyUrl, getAuthDir, getLogFilePath } from './config.js';
import type { ProxyCommand, AuthStatus } from './types.js';

// Track installed proxy binary path for this process
let installedProxyPath: string | null = null;

/**
 * Detect CLIProxyAPI command
 * Prefers locally installed binary from this process if available
 */
export async function detectProxyCommand(): Promise<ProxyCommand> {
  // Prefer locally installed binary from this process
  if (installedProxyPath && fileExists(installedProxyPath)) {
    return { cmd: 'cliproxyapi', path: installedProxyPath };
  }

  if (await hasCommand('cliproxyapi')) {
    try {
      // Use 'where' on Windows, 'which' on Unix/macOS
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const path = await execCommand(whichCmd, ['cliproxyapi']);
      return { cmd: 'cliproxyapi', path };
    } catch {
      // which/where might fail, continue anyway
      return { cmd: 'cliproxyapi', path: null };
    }
  }
  if (await hasCommand('cliproxy')) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const path = await execCommand(whichCmd, ['cliproxy']);
      return { cmd: 'cliproxy', path };
    } catch {
      return { cmd: 'cliproxy', path: null };
    }
  }
  return { cmd: null, path: null };
}

/**
 * Check if proxy is running
 */
export async function isProxyRunning(): Promise<boolean> {
  try {
    const proxyUrl = getProxyUrl();
    const { status } = await httpGet(`${proxyUrl}/v1/models`);
    return status === 200 || status === 401;
  } catch {
    return false;
  }
}

/**
 * Check auth configuration
 */
export async function checkAuthConfigured(): Promise<AuthStatus> {
  const authDir = getAuthDir();

  // Check for auth files
  const fs = await import('fs/promises');
  let hasAuthFiles = false;
  try {
    const files = await fs.readdir(authDir);
    hasAuthFiles = files.some(f => f.startsWith('codex-') && f.endsWith('.json'));
  } catch {
    // Directory doesn't exist
    debugLog('Auth directory does not exist:', authDir);
  }

  // Check auth via proxy status
  let hasAuthEntries = false;
  const cmdResult = await detectProxyCommand();
  if (cmdResult.cmd) {
    try {
      // Use absolute path if available, otherwise command name
      const proxyExe = cmdResult.path || cmdResult.cmd;
      const output = await execCommand(proxyExe, ['status']);
      // Match "N auth entries" or "N auth files" where N > 0
      const match = output.match(/(\d+)\s+(auth entries|auth files)/);
      if (match) {
        const count = parseInt(match[1], 10);
        hasAuthEntries = count > 0;
      }
    } catch (error) {
      debugLog('Failed to check proxy status:', error);
    }
  }

  // Check via API
  let hasModels = false;
  try {
    const proxyUrl = getProxyUrl();
    const response = await httpGet(`${proxyUrl}/v1/models`);
    if (response.status === 200) {
      const data = safeJsonParse<{ object: string; data: unknown[] }>(response.body);
      hasModels = data?.object === 'list' && Array.isArray(data.data) && data.data.length > 0;
    }
  } catch {
    // Proxy not running or not authenticated
    debugLog('Failed to check models via API');
  }

  return {
    hasAuthFiles,
    hasAuthEntries,
    hasModels,
    // Prioritize live API checks over cached files
    // Only consider configured if we can actually list models OR have confirmed auth entries
    configured: hasModels || (hasAuthEntries && hasAuthFiles),
  };
}

/**
 * Compute SHA-256 hash of binary data
 */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Parse checksum file to find expected hash for a specific file
 * Supports common checksum formats:
 * - SHA256SUMS: "a1b2c3...  filename" or "a1b2c3... *filename"
 * - checksums.txt: "a1b2c3... filename"
 */
function parseExpectedSha256(content: string, fileName: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match: hash followed by whitespace and filename (with optional * prefix)
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) {
      const [, hash, name] = match;
      if (name.trim() === fileName) {
        return hash.toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Fetch latest release info from GitHub API
 * Returns the exact tag name to avoid moving 'latest' redirects
 */
async function getLatestReleaseTag(): Promise<string> {
  const apiUrl = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest';

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': '@tuannvm/ccodex',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const data = await safeJsonParse<{ tag_name: string }>(await response.text());
    if (!data?.tag_name) {
      throw new Error('Invalid GitHub API response');
    }

    return data.tag_name;
  } catch (error) {
    debugLog('Failed to fetch latest release tag:', error);
    throw new Error(
      `Failed to resolve latest release tag from GitHub API: ${error instanceof Error ? error.message : String(error)}\n\n` +
      'Please check your internet connection or install CLIProxyAPI manually.'
    );
  }
}

/**
 * Install CLIProxyAPI via Homebrew or Go binary fallback
 */
export async function installProxyApi(): Promise<void> {
  const { homedir } = await import('os');
  const home = homedir();
  if (!home) {
    throw new Error('Cannot determine home directory. Please set HOME environment variable.');
  }

  // Check platform
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    throw new Error(
      'CLIProxyAPI installation on Windows requires manual setup.\n' +
      'Please install CLIProxyAPI manually and ensure it\'s in your PATH.\n' +
      'See CLIProxyAPI documentation for Windows installation instructions.'
    );
  }

  // Try Homebrew first (preferred)
  if (await hasCommand('brew')) {
    console.log('Installing CLIProxyAPI via Homebrew...');

    const spawnCmd = (await import('cross-spawn')).default;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawnCmd('brew', ['install', 'cliproxyapi'], {
          stdio: 'inherit',
        });

        child.on('close', (code: number | null) => {
          if (code === 0) {
            console.log('CLIProxyAPI installed successfully via Homebrew');
            resolve();
          } else {
            reject(new Error('Failed to install CLIProxyAPI via Homebrew'));
          }
        });

        child.on('error', (error: Error) => reject(error));
      });
      return;
    } catch (error) {
      debugLog('Homebrew installation failed, falling back to Go binary:', error);
      // Fall through to Go binary installation
    }
  }

  // Fallback: Install Go binary directly
  console.log('Installing CLIProxyAPI via Go binary...');

  // Validate and determine platform suffix
  const supportedPlatforms = ['darwin', 'linux'];
  const supportedArches = ['arm64', 'x64'];

  if (!supportedPlatforms.includes(platform)) {
    throw new Error(
      `Unsupported platform: ${platform}\n` +
      `Supported platforms: ${supportedPlatforms.join(', ')}`
    );
  }

  if (!supportedArches.includes(arch)) {
    throw new Error(
      `Unsupported architecture: ${arch}\n` +
      `Supported architectures: ${supportedArches.join(', ')}`
    );
  }

  const platformSuffix = `${platform}-${arch === 'arm64' ? 'arm64' : 'amd64'}`;
  const binaryFileName = `cliproxyapi-${platformSuffix}`;
  const installDir = join(home, '.local', 'bin');
  const binaryPath = join(installDir, 'cliproxyapi');
  const tempPath = join(installDir, `cliproxyapi.tmp.${Date.now()}`);

  // Ensure install directory exists
  await ensureDir(installDir);

  // Resolve exact release tag first for security (avoid moving 'latest' redirects)
  console.log('Resolving latest release tag from GitHub API...');
  const releaseTag = await getLatestReleaseTag();
  console.log(`Latest release: ${releaseTag}`);

  const baseUrl = `https://github.com/router-for-me/CLIProxyAPI/releases/download/${releaseTag}`;
  const binaryUrl = `${baseUrl}/${binaryFileName}`;

  console.log(`Downloading ${binaryFileName} from GitHub releases...`);

  const fs = await import('fs/promises');

  try {
    // Download binary with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    let response: Response;
    try {
      response = await fetch(binaryUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}\n` +
        `URL: ${binaryUrl}\n` +
        `Platform/Arch: ${platformSuffix}`
      );
    }

    const buffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    // Calculate SHA-256 checksum of downloaded binary
    console.log('Calculating SHA-256 checksum...');
    const actualHash = sha256Hex(uint8Array);

    // Try to download and verify checksums file
    let checksumVerified = false;
    let checksumMismatchError: Error | null = null;
    const checksumUrls = [
      `${baseUrl}/SHA256SUMS`,
      `${baseUrl}/checksums.txt`,
      `${baseUrl}/checksums.sha256`,
    ];

    for (const checksumUrl of checksumUrls) {
      try {
        console.log(`Attempting checksum verification from: ${new URL(checksumUrl).pathname}`);
        const checksumResponse = await fetch(checksumUrl, { signal: AbortSignal.timeout(10000) });

        if (checksumResponse.ok) {
          const checksumContent = await checksumResponse.text();
          const expectedHash = parseExpectedSha256(checksumContent, binaryFileName);

          if (expectedHash) {
            if (actualHash === expectedHash) {
              console.log(chalk.green('✓ Checksum verification passed'));
              checksumVerified = true;
              break;
            } else {
              // Checksum mismatch - this is FATAL, do not continue
              await fs.unlink(tempPath).catch(() => {});
              checksumMismatchError = new Error(
                `Checksum verification failed!\n` +
                `Expected: ${expectedHash}\n` +
                `Actual:   ${actualHash}\n\n` +
                `The downloaded binary may be corrupted or tampered with.\n` +
                `Please try again or install CLIProxyAPI manually.`
              );
              break; // Exit loop immediately on mismatch
            }
          }
        }
      } catch (checksumError) {
        // Only catch network/parsing errors - let checksum mismatches fail hard
        const errorMsg = checksumError instanceof Error ? checksumError.message : String(checksumError);
        if (errorMsg.includes('Checksum verification failed')) {
          // Re-throw checksum mismatch errors
          throw checksumError;
        }
        debugLog(`Checksum verification failed for ${checksumUrl}:`, checksumError);
        // Try next checksum URL on network errors
      }
    }

    // If we found a checksum mismatch, fail hard
    if (checksumMismatchError) {
      throw checksumMismatchError;
    }

    // SECURITY: Fail closed if checksum verification is not available
    // This prevents installation of potentially tampered binaries
    if (!checksumVerified) {
      await fs.unlink(tempPath).catch(() => {});
      throw new Error(
        chalk.red('Checksum verification required but failed.\n\n') +
        'The downloaded binary could not be verified against a checksum file.\n' +
        'This is a security requirement to prevent installation of tampered binaries.\n\n' +
        'Possible reasons:\n' +
        '  - Network issues prevented checksum file download\n' +
        '  - Checksum files are not published for this release\n' +
        '  - GitHub releases are temporarily unavailable\n\n' +
        'To install CLIProxyAPI safely:\n' +
        `  1. Visit ${baseUrl}/\n` +
        '  2. Download the binary and checksum files manually\n' +
        '  3. Verify the checksums match\n' +
        '  4. Place the binary in a directory in your PATH\n' +
        '  5. Make it executable: chmod +x cliproxyapi\n\n' +
        'Then run ccodex again.'
      );
    }

    // Atomic write: download to temp file first
    await fs.writeFile(tempPath, uint8Array, { mode: 0o755 });

    // Sync to disk
    const fileHandle = await fs.open(tempPath, 'r');
    try {
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    // Validate the binary works by running it
    try {
      const { spawnSync } = await import('child_process');
      const testResult = spawnSync(tempPath, ['--version'], { timeout: 5000 });

      // Fail on any error, signal termination, or non-zero exit
      if (testResult.error || testResult.signal !== null || testResult.status !== 0) {
        const reason = testResult.error?.message ||
                      (testResult.signal ? `killed by signal ${testResult.signal}` : null) ||
                      (testResult.status ? `exited with code ${testResult.status}` : 'unknown error');
        throw new Error(`Binary validation failed: ${reason}`);
      }
    } catch (validationError) {
      // Clean up invalid binary
      await fs.unlink(tempPath).catch(() => {});
      throw new Error(
        `Downloaded binary failed validation: ${validationError instanceof Error ? validationError.message : String(validationError)}\n\n` +
        'The binary may be corrupted or incompatible with your system.'
      );
    }

    // Backup existing binary if present, but be ready to rollback
    let backupPath: string | null = null;
    let didBackup = false;
    if (await fileExists(binaryPath)) {
      backupPath = `${binaryPath}.backup.${Date.now()}`;
      await fs.rename(binaryPath, backupPath);
      didBackup = true;
    }

    // Move temp file to final location (atomic on most filesystems)
    try {
      await fs.rename(tempPath, binaryPath);
      // Store the installed path for this process
      installedProxyPath = binaryPath;
    } catch (renameError) {
      // Rollback: restore backup if we had one
      if (didBackup && backupPath) {
        try {
          await fs.rename(backupPath, binaryPath);
        } catch (rollbackError) {
          debugLog('Failed to rollback after rename failure:', rollbackError);
        }
      }
      throw new Error(
        `Failed to move binary to final location: ${renameError instanceof Error ? renameError.message : String(renameError)}`
      );
    }

    // Clean up backup on success
    if (backupPath) {
      fs.unlink(backupPath).catch(() => {});
    }

    console.log(`CLIProxyAPI installed successfully to: ${binaryPath}`);

    // Check if install dir is in PATH
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(':');
    const binInPath = pathDirs.some(dir => dir === installDir);

    if (!binInPath) {
      console.log('');
      console.log('⚠️  WARNING: ~/.local/bin is not in your PATH');
      console.log('');
      console.log('To use ccodex, add ~/.local/bin to your PATH:');
      console.log('');
      console.log('  For bash (add to ~/.bashrc):');
      console.log('    export PATH="$HOME/.local/bin:$PATH"');
      console.log('');
      console.log('  For zsh (add to ~/.zshrc):');
      console.log('    export PATH="$HOME/.local/bin:$PATH"');
      console.log('');
      console.log('Then reload your shell: source ~/.bashrc (or ~/.zshrc)');
    }
  } catch (error) {
    // Clean up temp file on error
    fs.unlink(tempPath).catch(() => {});

    throw new Error(
      `Failed to install CLIProxyAPI: ${error instanceof Error ? error.message : String(error)}\n\n` +
      'Please install CLIProxyAPI manually:\n' +
      '  1. Visit https://github.com/router-for-me/CLIProxyAPI/releases\n' +
      `  2. Download ${binaryFileName} for your system\n` +
      '  3. Place it in a directory in your PATH\n' +
      '  4. Make it executable: chmod +x cliproxyapi'
    );
  }
}

/**
 * Start proxy in background
 */
export async function startProxy(): Promise<void> {
  if (await isProxyRunning()) {
    return;
  }

  const cmdResult = await detectProxyCommand();
  // Use absolute path if available, otherwise command name
  const proxyExe = cmdResult.path || cmdResult.cmd;
  if (!proxyExe) {
    throw new Error('CLIProxyAPI not found. Run: npx -y @tuannvm/ccodex');
  }

  console.log('Starting CLIProxyAPI in background...');

  const logFile = getLogFilePath();
  await ensureDir(join(logFile, '..'));

  const { spawn } = await import('child_process');
  const fs = await import('fs/promises');

  let out: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    // Create log with restrictive permissions (user read/write only)
    out = await fs.open(logFile, 'a');

    // Set restrictive permissions on Unix/macOS (0600 = user read/write only)
    if (process.platform !== 'win32') {
      try {
        await fs.chmod(logFile, 0o600);
      } catch {
        // If chmod fails, continue anyway - the file was created successfully
        debugLog('Warning: Could not set restrictive permissions on log file');
      }
    }

    const child = spawn(proxyExe, [], {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
    });

    // Handle spawn errors immediately (fail-fast)
    await new Promise<void>((resolve, reject) => {
      child.once('error', (error: Error) => {
        reject(new Error(`Failed to start CLIProxyAPI: ${error.message}`));
      });
      child.once('spawn', () => resolve());
    });

    child.unref();

    // Wait for proxy to be ready
    for (let i = 0; i < CONFIG.PROXY_STARTUP_MAX_RETRIES; i++) {
      await sleep(CONFIG.PROXY_STARTUP_RETRY_DELAY_MS);
      if (await isProxyRunning()) {
        console.log('CLIProxyAPI is running.');
        return;
      }
    }

    throw new Error(`CLIProxyAPI did not become ready. Check logs: ${logFile}`);
  } finally {
    if (out) {
      await out.close();
    }
  }
}

/**
 * Launch OAuth login
 */
export async function launchLogin(): Promise<void> {
  const cmdResult = await detectProxyCommand();
  // Use absolute path if available, otherwise command name
  const proxyExe = cmdResult.path || cmdResult.cmd;
  if (!proxyExe) {
    throw new Error('CLIProxyAPI not found. Run: npx -y @tuannvm/ccodex');
  }

  console.log('Launching ChatGPT/Codex OAuth login in browser...');

  const spawnCmd = (await import('cross-spawn')).default;
  return new Promise<void>((resolve, reject) => {
    const child = spawnCmd(proxyExe, ['-codex-login'], {
      stdio: 'inherit',
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('Login failed'));
      }
    });

    child.on('error', (error: Error) => reject(error));
  });
}

/**
 * Wait for auth to be configured after login
 */
export async function waitForAuth(): Promise<void> {
  console.log('Waiting for authentication...');

  for (let i = 0; i < CONFIG.AUTH_WAIT_MAX_RETRIES; i++) {
    await sleep(CONFIG.AUTH_WAIT_RETRY_DELAY_MS);
    const auth = await checkAuthConfigured();
    if (auth.configured) {
      console.log('Authentication configured.');
      return;
    }
  }

  throw new Error('Authentication still not configured after login.');
}
