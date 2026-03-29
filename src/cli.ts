#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { detectProxyCommand, installProxyApi, startProxy, launchLogin, waitForAuth, checkAuthConfigured } from './proxy.js';
import { installAliases, configureShellIntegration } from './aliases.js';
import { printStatus, readyCheck } from './status.js';
import { runClaude, detectClaudeCommand, installClaudeCode } from './claude.js';

/**
 * Ensure everything is set up (idempotent)
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

  // 3. Install aliases (claude-openai, ccodex)
  await installAliases();

  // 4. Configure shell integration
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
    .version('0.1.0')
    .option('--login', 'Run ChatGPT/Codex OAuth login')
    .option('--status', 'Show setup status')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .parse(process.argv);

  const options = program.opts();

  // Handle --login
  if (options.login) {
    // Ensure setup (installs dependencies, starts proxy)
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

    await installAliases();
    await configureShellIntegration();
    await startProxy();

    // Always launch login flow for --login, even if already authenticated
    // This allows users to switch accounts or refresh their session
    await launchLogin();
    return;
  }

  // Handle --status
  if (options.status) {
    // Ensure setup is done before showing status
    // This ensures proxy is running and status is accurate
    await ensureSetup();
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
  console.error(chalk.red('Error:'), error.message);
  process.exit(1);
});
