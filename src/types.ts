/**
 * Platform detection results
 */
export interface Platform {
  os: 'darwin' | 'linux' | 'windows';
  shell: 'zsh' | 'bash' | 'cmd' | 'powershell' | null;
  home: string;
}

/**
 * CLIProxyAPI command detection
 */
export interface ProxyCommand {
  cmd: 'cliproxyapi' | 'cliproxy' | null;
  path: string | null;
}

/**
 * Auth configuration status
 */
export interface AuthStatus {
  hasAuthFiles: boolean;
  hasAuthEntries: boolean;
  hasModels: boolean;
  configured: boolean;
}

/**
 * Status check results
 */
export interface StatusResult {
  proxyCommand: boolean;
  proxyRunning: boolean;
  authConfigured: boolean;
  aliasesInstalled: boolean;
  shellIntegration: boolean;
  claudeCliAvailable: boolean;
  ready: boolean;
}

/**
 * CLI options
 */
export interface CliOptions {
  login?: boolean;
  status?: boolean;
}

/**
 * Shell configuration
 */
export interface ShellConfig {
  rcFile: string;
  aliasFile: string;
  sourceLine: string;
}
