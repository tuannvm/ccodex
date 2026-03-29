import spawnCmd from 'cross-spawn';
import { join } from 'path';
import { homedir } from 'os';
import { hasCommand, getCommandPath, ensureDir, getUid, fileExists } from './utils.js';
import { startProxy, checkAuthConfigured, launchLogin, waitForAuth } from './proxy.js';

// Track locally installed Claude CLI path for this process
let installedClaudePath: string | null = null;

/**
 * Get the deterministic persistent path for local Claude CLI installation
 * This path is used across process invocations to persistently discover
 * locally-installed Claude CLI when global install fails
 * Handles platform differences (Unix vs Windows)
 */
function getPersistentLocalClaudePath(): string {
  const home = homedir();

  if (process.platform === 'win32') {
    // Windows: npm installs to AppData/local/prefix, with .cmd wrappers
    // Try claude.cmd first (npm wrapper), then claude.exe (actual binary)
    const localPrefix = join(home, 'AppData', 'Local', 'ccodex', 'npm');
    return join(localPrefix, 'node_modules', '.bin', 'claude.cmd');
  }

  // Unix/macOS: ~/.local/ccodex/npm/node_modules/.bin/claude
  return join(home, '.local', 'ccodex', 'npm', 'node_modules', '.bin', 'claude');
}

/**
 * Detect Claude Code installation
 * Checks multiple sources in priority order:
 * 1. Process-local path (fast path for current process)
 * 2. Persistent local fallback path (for previously-installed local CLI)
 * 3. System PATH (for globally-installed CLI)
 */
export async function detectClaudeCommand(): Promise<{ cmd: string | null; path: string | null }> {
  // 1. Prefer locally installed binary from this process (fast path)
  if (installedClaudePath && fileExists(installedClaudePath)) {
    return { cmd: installedClaudePath, path: installedClaudePath };
  }

  // 2. Check persistent local fallback path (for previously-installed CLI)
  const persistentLocal = getPersistentLocalClaudePath();
  if (fileExists(persistentLocal)) {
    // Update process-local cache for faster subsequent checks
    installedClaudePath = persistentLocal;
    return { cmd: persistentLocal, path: persistentLocal };
  }

  // 3. Check system PATH for global installation
  if (await hasCommand('claude')) {
    const resolved = await getCommandPath('claude');
    return { cmd: 'claude', path: resolved };
  }
  return { cmd: null, path: null };
}

/**
 * Helper to run npm install and capture stderr
 */
async function runNpmInstall(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const spawn = (await import('cross-spawn')).default;
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', code => resolve({ ok: code === 0, stderr }));
  });
}

/**
 * Install Claude Code via npm with fallback to local prefix
 */
export async function installClaudeCode(): Promise<void> {
  // Check if npm is available
  if (!(await hasCommand('npm'))) {
    throw new Error('npm not found. Install Node.js with npm first.');
  }

  console.log('Installing Claude Code CLI via npm...');

  // Try global install first
  const global = await runNpmInstall(['install', '-g', '@anthropic-ai/claude-code']);
  if (global.ok) {
    console.log('Claude Code CLI installed successfully via npm global');
    return;
  }

  // Check if it was a permission error
  const permissionDenied = /EACCES|permission denied/i.test(global.stderr);
  if (!permissionDenied) {
    throw new Error('Failed to install Claude Code CLI');
  }

  // Fallback to local install
  // Use platform-specific local prefix path
  let localPrefix: string;
  if (process.platform === 'win32') {
    localPrefix = join(homedir(), 'AppData', 'Local', 'ccodex', 'npm');
  } else {
    localPrefix = join(homedir(), '.local', 'ccodex', 'npm');
  }
  console.log(`Global install denied. Falling back to local prefix: ${localPrefix}`);

  const local = await runNpmInstall(['install', '--prefix', localPrefix, '@anthropic-ai/claude-code']);
  if (!local.ok) {
    throw new Error('Failed to install Claude Code CLI (global + local fallback both failed)');
  }

  // Store the installed path using the persistent path function
  installedClaudePath = getPersistentLocalClaudePath();
  console.log(`Claude Code CLI installed locally: ${installedClaudePath}`);
}

/**
 * Run Claude Code CLI with proxy environment
 */
export async function runClaude(args: string[]): Promise<void> {
  // Detect Claude CLI using comprehensive detection (process-local, persistent local, system PATH)
  const claudeCmd = await detectClaudeCommand();
  if (!claudeCmd.cmd) {
    throw new Error('claude CLI not found in PATH\nInstall Claude Code CLI first, then rerun: npx -y @tuannvm/ccodex');
  }

  // Use detected command (absolute path or command name)
  const claudeExe = claudeCmd.cmd;

  // Ensure proxy is running
  await startProxy();

  // Check auth, launch login if needed
  const auth = await checkAuthConfigured();
  if (!auth.configured) {
    console.log('ChatGPT/Codex auth not configured. Starting login...');
    await launchLogin();
    await waitForAuth();
  }

  // Set up temp directory (cross-platform)
  const uid = getUid();
  let tmpBase: string;
  if (process.platform === 'win32') {
    tmpBase = process.env.TEMP || process.env.TMP || `C:\\Temp\\claude-${uid}`;
  } else {
    tmpBase = process.env.TMPDIR || `/tmp/claude-${uid}`;
  }
  const tmpDir = join(tmpBase, '');
  await ensureDir(tmpDir);

  // Get user home directory (cross-platform)
  const { homedir } = await import('os');
  const userHome = homedir();

  // Environment for Claude with proxy
  // Minimal allowlist for subprocess environment.
  // Default-deny: only pass values required for process execution and terminal UX.
  const allowedEnvKeys = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'FORCE_COLOR',
    'CI',
    'SHELL',
    'PWD',
    'OLDPWD',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ]);

  // Permit npm config without broad env leakage.
  function isAllowedByPrefix(key: string): boolean {
    return key.startsWith('npm_config_');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;

    // On Windows env keys are case-insensitive; normalize for allowlist matching.
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    const allowed = allowedEnvKeys.has(normalized) || isAllowedByPrefix(key);

    if (allowed) {
      env[key] = value;
    }
  }

  // Set proxy config - dummy token is replaced by CLIProxyAPI's OAuth credentials
  // The proxy handles ChatGPT authentication, this is just a format placeholder
  env.ANTHROPIC_AUTH_TOKEN = 'sk-dummy';
  env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8317';
  env.API_TIMEOUT_MS = '120000';

  // Model mappings to GPT-5.3 Codex
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'gpt-5.3-codex(xhigh)';
  env.ANTHROPIC_MODEL = 'gpt-5.3-codex(medium)';
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gpt-5.3-codex(high)';
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gpt-5.3-codex(low)';
  env.CLAUDE_CODE_SUBAGENT_MODEL = 'gpt-5.3-codex(medium)';

  // Other settings
  env.TMPDIR = tmpDir;

  // On Windows, also set TEMP and TMP for compatibility
  if (process.platform === 'win32') {
    env.TEMP = tmpDir;
    env.TMP = tmpDir;
  }

  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_COST_WARNINGS = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CONFIG_DIR = join(userHome, '.claude-openai');

  // Spawn Claude with modified environment
  const child = spawnCmd(claudeExe, args, {
    stdio: 'inherit',
    env,
  });

  return new Promise<void>((resolve, reject) => {
    child.on('close', (code, signal) => {
      // Exit code 0 means success
      // SIGINT (Ctrl+C) or SIGTERM are user-initiated, treat as success
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
        resolve();
      } else if (code === 130) {
        // Exit code 130 is also typically from SIGINT (128 + 2)
        resolve();
      } else {
        // Non-zero exit with no signal indicates an error
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}
