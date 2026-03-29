#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { detectProxyCommand, installProxyApi, startProxy, launchLogin, waitForAuth, checkAuthConfigured } from './proxy.js';
import { configureShellIntegration } from './aliases.js';
import { printStatus, readyCheck } from './status.js';
import { runClaude, detectClaudeCommand, installClaudeCode } from './claude.js';

/**
 * Preflight check - validate platform and capabilities before main operations
 * Only runs for non-status commands to allow read-only diagnostics anywhere
 */
function preflightOrThrow(): void {
  const platform = process.platform;
  const arch = process.arch;

  // Check Node.js version
  const nodeMajorVersion = Number(process.versions.node.split('.')[0]);
  if (nodeMajorVersion < 18) {
    throw new Error(
      `Node.js ${process.versions.node} detected.\n` +
      `Please use Node.js >= 18. You have ${process.versions.node}.`
    );
  }

  // Check OS support
  const supportedPlatforms = ['darwin', 'linux', 'win32'];
  if (!supportedPlatforms.includes(platform)) {
    throw new Error(
      `Unsupported OS: ${platform}\n` +
      `Supported platforms: ${supportedPlatforms.join(', ')}`
    );
  }

  // Check architecture for proxy auto-install (Unix/Linux only)
  if (platform === 'darwin' || platform === 'linux') {
    const supportedArches = ['arm64', 'x64'];
    if (!supportedArches.includes(arch)) {
      throw new Error(
        `Unsupported architecture for CLIProxyAPI auto-install: ${arch}\n` +
        `Supported architectures: ${supportedArches.join(', ')}\n` +
        `CLIProxyAPI must be installed manually for your architecture.`
      );
    }
  }

  // Windows warning
  if (platform === 'win32') {
    console.log(chalk.yellow(
      'Windows detected: CLIProxyAPI requires manual installation.\n' +
      'Install from: https://github.com/router-for-me/CLIProxyAPI/releases'
    ));
  }
}

/**
 * Ensure everything is set up (idempotent)
 * Implements steps 1-5 of the ccodex workflow:
 * 1. Check/install Claude Code CLI
 * 2. Check/install CLIProxyAPI
 * 3. Configure shell integration (adds aliases directly to rc files)
 * 4. Start proxy
 * 5. Launch OAuth login if needed
 *
 * Step 6 (Run Claude Code) is handled by main() after setup completes.
 */
async function ensureSetup(): Promise<void> {
  let needsSetup = false;

  // 1. Check/install Claude Code CLI
  const claudeCmd = await detectClaudeCommand();
  if (!claudeCmd.cmd) {
    console.log(chalk.yellow('Claude Code CLI not found. Installing...'));
    await installClaudeCode();
    needsSetup = true;
  }

  // 2. Check/install CLIProxyAPI
  const proxyCmd = await detectProxyCommand();
  if (!proxyCmd.cmd) {
    await installProxyApi();
    needsSetup = true;
  }

  // 3. Configure shell integration (adds aliases directly to rc files)
  await configureShellIntegration();

  // 5. Start proxy
  await startProxy();

  // 6. Check auth, launch login if needed
  const auth = await checkAuthConfigured();
  if (!auth.configured) {
    console.log(chalk.yellow('ChatGPT/Codex auth not configured. Starting login...'));
    await launchLogin();
    await waitForAuth();
    needsSetup = true;
  }

  if (needsSetup) {
    console.log('');
    await readyCheck();
    console.log('');
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('ccodex')
    .description('TypeScript reimplementation of ccodex - run Claude Code with OpenAI GPT models')
    .version('0.1.3')
    .option('--login', 'Run ChatGPT/Codex OAuth login')
    .option('--status', 'Show setup status')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .parse(process.argv);

  const options = program.opts();

  // Preflight check for all operations except --status (read-only diagnostics)
  if (!options.status) {
    preflightOrThrow();
  }

  // Handle --login
  if (options.login) {
    // Ensure setup (installs dependencies, configures shell, starts proxy)
    // Skip the auth part of ensureSetup by checking first
    const claudeCmd = await detectClaudeCommand();
    if (!claudeCmd.cmd) {
      console.log(chalk.yellow('Claude Code CLI not found. Installing...'));
      await installClaudeCode();
    }

    const proxyCmd = await detectProxyCommand();
    if (!proxyCmd.cmd) {
      await installProxyApi();
    }

    await configureShellIntegration();
    await startProxy();

    // Always launch login flow for --login, even if already authenticated
    // This allows users to switch accounts or refresh their session
    await launchLogin();
    return;
  }

  // Handle --status (read-only, no side effects)
  if (options.status) {
    await printStatus();
    return;
  }

  // Default: ensure setup and run Claude Code
  await ensureSetup();

  // Get remaining args for Claude Code
  const args = program.args;
  await runClaude(args);
}

main().catch((error) => {
  // Normalize error to Error instance
  const err = error instanceof Error ? error : new Error(String(error));

  console.error(chalk.red('Error:'), err.message);

  // Print stack trace in debug mode
  if (process.env.DEBUG || process.env.CCODEX_DEBUG) {
    console.error(chalk.gray(err.stack));
  }

  process.exit(1);
});
