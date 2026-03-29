import chalk from 'chalk';
import { detectProxyCommand, isProxyRunning, checkAuthConfigured } from './proxy.js';
import { isShellIntegrationConfigured } from './aliases.js';
import { detectClaudeCommand } from './claude.js';
import type { StatusResult } from './types.js';

/**
 * Print status line
 */
function statusLine(label: string, ok: boolean): void {
  if (ok) {
    console.log(chalk.green('  [OK]') + '      ' + label);
  } else {
    console.log(chalk.red('  [MISSING]') + ' ' + label);
  }
}

/**
 * Print full status
 */
export async function printStatus(): Promise<void> {
  console.log('');
  console.log(chalk.bold('ccodex status'));

  const result = await getStatus();

  statusLine('CLIProxyAPI command available', result.proxyCommand);
  statusLine('CLIProxyAPI running on 127.0.0.1:8317', result.proxyRunning);
  statusLine('ChatGPT/Codex auth configured', result.authConfigured);
  statusLine('ccodex/co/claude-openai aliases installed', result.aliasesInstalled);
  statusLine('Shell rc integration configured', result.shellIntegration);
  statusLine('Claude CLI available', result.claudeCliAvailable);
}

/**
 * Get status result
 */
export async function getStatus(): Promise<StatusResult> {
  const proxyCmd = await detectProxyCommand();
  const proxyRunning = await isProxyRunning();
  const auth = await checkAuthConfigured();
  const shellIntegration = await isShellIntegrationConfigured();
  const claudeCmd = await detectClaudeCommand();

  return {
    proxyCommand: proxyCmd.cmd !== null,
    proxyRunning,
    authConfigured: auth.configured,
    aliasesInstalled: shellIntegration,
    shellIntegration,
    claudeCliAvailable: claudeCmd.cmd !== null,
    ready:
      proxyCmd.cmd !== null &&
      proxyRunning &&
      auth.configured &&
      shellIntegration &&
      claudeCmd.cmd !== null,
  };
}

/**
 * Ready check with exit code
 */
export async function readyCheck(): Promise<boolean> {
  await printStatus();

  const result = await getStatus();

  if (result.ready) {
    console.log('');
    console.log(chalk.green('Ready: run') + ' ' + chalk.bold('ccodex') + ', ' + chalk.bold('co') + ', or ' + chalk.bold('claude-openai') + '.');
    return true;
  }

  console.log('');
  console.log(
    chalk.yellow('Not ready: run') +
      ' ' +
      chalk.bold('npx -y @tuannvm/ccodex') +
      ' again to complete setup.'
  );
  return false;
}
