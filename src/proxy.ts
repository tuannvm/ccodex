import { join } from 'path';
import { hasCommand, execCommand, httpGet, sleep, ensureDir, fileExists, safeJsonParse, debugLog } from './utils.js';
import { CONFIG, getProxyUrl, getAuthDir, getLogFilePath } from './config.js';
import type { ProxyCommand, AuthStatus } from './types.js';

/**
 * Detect CLIProxyAPI command
 */
export async function detectProxyCommand(): Promise<ProxyCommand> {
  if (await hasCommand('cliproxyapi')) {
    try {
      const path = await execCommand('which', ['cliproxyapi']);
      return { cmd: 'cliproxyapi', path };
    } catch {
      // which might fail, continue anyway
      return { cmd: 'cliproxyapi', path: null };
    }
  }
  if (await hasCommand('cliproxy')) {
    try {
      const path = await execCommand('which', ['cliproxy']);
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
      const output = await execCommand(cmdResult.cmd, ['status']);
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
 * Install CLIProxyAPI via Homebrew or Go binary fallback
 */
export async function installProxyApi(): Promise<void> {
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

  // Determine the correct binary name based on platform and architecture
  let binaryName = 'cliproxyapi';
  let platformSuffix = '';

  if (platform === 'darwin') {
    platformSuffix = arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
  } else if (platform === 'linux') {
    platformSuffix = arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const binaryFileName = `cliproxyapi-${platformSuffix}`;
  const installDir = join(process.env.HOME || '', '.local', 'bin');
  const binaryPath = join(installDir, binaryName);

  // Ensure install directory exists
  await ensureDir(installDir);

  // Download the binary
  const releaseUrl = `https://github.com/router-for-me/CLIProxyAPI/releases/latest/download/${binaryFileName}`;

  console.log(`Downloading from ${releaseUrl}...`);

  try {
    const response = await fetch(releaseUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    // Write binary to file
    const fs = await import('fs/promises');
    await fs.writeFile(binaryPath, uint8Array);

    // Make binary executable
    await fs.chmod(binaryPath, 0o755);

    console.log(`CLIProxyAPI installed successfully to: ${binaryPath}`);
    console.log('Make sure ~/.local/bin is in your PATH.');
  } catch (error) {
    throw new Error(
      `Failed to download CLIProxyAPI binary: ${error instanceof Error ? error.message : String(error)}\n\n` +
      'Please install CLIProxyAPI manually:\n' +
      '  1. Visit https://github.com/router-for-me/CLIProxyAPI/releases\n' +
      '  2. Download the appropriate binary for your platform\n' +
      '  3. Place it in your PATH\n' +
      '  4. Make it executable (chmod +x cliproxyapi)'
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
  const proxyCmd = cmdResult.cmd;
  if (!proxyCmd) {
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

    const child = spawn(proxyCmd, [], {
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
  const proxyCmd = cmdResult.cmd;
  if (!proxyCmd) {
    throw new Error('CLIProxyAPI not found. Run: npx -y @tuannvm/ccodex');
  }

  console.log('Launching ChatGPT/Codex OAuth login in browser...');

  const spawnCmd = (await import('cross-spawn')).default;
  return new Promise<void>((resolve, reject) => {
    const child = spawnCmd(proxyCmd, ['-codex-login'], {
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
