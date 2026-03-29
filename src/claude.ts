import spawnCmd from 'cross-spawn';
import { join } from 'path';
import { hasCommand, ensureDir, getUid } from './utils.js';
import { startProxy, checkAuthConfigured, launchLogin, waitForAuth } from './proxy.js';

/**
 * Detect Claude Code installation
 */
export async function detectClaudeCommand(): Promise<{ cmd: string | null; path: string | null }> {
  if (await hasCommand('claude')) {
    try {
      const { execCommand } = await import('./utils.js');
      const path = await execCommand('which', ['claude']);
      return { cmd: 'claude', path };
    } catch {
      return { cmd: 'claude', path: null };
    }
  }
  return { cmd: null, path: null };
}

/**
 * Install Claude Code via npm
 */
export async function installClaudeCode(): Promise<void> {
  // Check if npm is available
  if (!(await hasCommand('npm'))) {
    throw new Error('npm not found. Install Node.js with npm first.');
  }

  console.log('Installing Claude Code CLI via npm...');

  const spawnCmd = (await import('cross-spawn')).default;
  return new Promise<void>((resolve, reject) => {
    const child = spawnCmd('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      stdio: 'inherit',
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('Claude Code CLI installed successfully');
        resolve();
      } else {
        reject(new Error('Failed to install Claude Code CLI'));
      }
    });

    child.on('error', (error: Error) => reject(error));
  });
}

/**
 * Run Claude Code CLI with proxy environment
 */
export async function runClaude(args: string[]): Promise<void> {
  if (!(await hasCommand('claude'))) {
    throw new Error('claude CLI not found in PATH\nInstall Claude Code CLI first, then rerun: npx -y @tuannvm/ccodex');
  }

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
  // Start from process.env but explicitly exclude Anthropic keys
  const env: Record<string, string | undefined> = {
    ...process.env,
  };

  // Explicitly unset ALL API keys to force use of proxy auth only
  // NO API key fallback - authentication must happen through ChatGPT OAuth
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_API_KEY;
  delete env.OPENAI_API_KEY;  // Ensure no OpenAI API key fallback

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
  const child = spawnCmd('claude', args, {
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
