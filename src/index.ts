/**
 * claudex - TypeScript reimplementation of ccodex
 *
 * Drop-in replacement for ccodex that runs Claude Code CLI with
 * OpenAI GPT models via CLIProxyAPI.
 */

// Re-export main functions
export { runClaude } from './claude.js';
export { detectProxyCommand, isProxyRunning, checkAuthConfigured, installProxyApi, startProxy, launchLogin, waitForAuth } from './proxy.js';
export { installAliases, configureShellIntegration, hasAliasFile, isShellIntegrationConfigured } from './aliases.js';
export { printStatus, readyCheck, getStatus } from './status.js';

// Types
export type { Platform, ProxyCommand, AuthStatus, StatusResult, CliOptions, ShellConfig } from './types.js';
