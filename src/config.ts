/**
 * Runtime configuration constants
 */

import { join } from "path";
import { homedir } from "os";

export const CONFIG = {
  // Proxy configuration
  PROXY_HOST: "127.0.0.1",
  PROXY_PORT: 8317,
  PROXY_STARTUP_MAX_RETRIES: 10,
  PROXY_STARTUP_RETRY_DELAY_MS: 1000,
  PROXY_KILL_WAIT_MS: 2000,
  AUTH_WAIT_MAX_RETRIES: 45,
  AUTH_WAIT_RETRY_DELAY_MS: 1000,

  // Paths
  AUTH_DIR_NAME: ".cli-proxy-api",
  CACHE_DIR_NAME: ".cache",
  LOG_FILE_NAME: "ccodex-cliproxy.log",
  CLAUDE_CONFIG_DIR: ".claude-openai",

  // Timeouts (in milliseconds)
  API_TIMEOUT_MS: 120000,
} as const;

/**
 * Get proxy URL
 */
export function getProxyUrl(): string {
  return `http://${CONFIG.PROXY_HOST}:${CONFIG.PROXY_PORT}`;
}

/**
 * Get auth directory path
 */
export function getAuthDir(): string {
  return join(homedir(), CONFIG.AUTH_DIR_NAME);
}

/**
 * Get log file path
 */
export function getLogFilePath(): string {
  return join(homedir(), CONFIG.CACHE_DIR_NAME, CONFIG.LOG_FILE_NAME);
}
