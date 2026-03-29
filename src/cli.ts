#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import {
  detectProxyCommand,
  installProxyApi,
  startProxy,
  launchLogin,
  waitForAuth,
  checkAuthConfigured,
} from "./proxy.js";
import { configureShellIntegration, isShellIntegrationConfigured } from "./aliases.js";
import { printStatus, readyCheck } from "./status.js";
import { runClaude, detectClaudeCommand, installClaudeCode } from "./claude.js";

/**
 * Get version from package.json
 * Reads version dynamically to avoid hardcoded version mismatch
 */
function getVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, "..", "package.json");

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Show proxy and auth diagnostic information
 */
async function showProxyDiagnostics(): Promise<void> {
  const { isProxyRunning, checkAuthConfigured, detectProxyCommand } = await import("./proxy.js");

  console.log("");
  console.log(chalk.bold("Proxy & Auth Diagnostics"));
  console.log("");

  // Check proxy command
  const proxyCmd = await detectProxyCommand();
  if (proxyCmd.cmd) {
    console.log(chalk.green(`✓ Proxy command found:`), proxyCmd.cmd);
    if (proxyCmd.path) {
      console.log(chalk.gray(`  Path: ${proxyCmd.path}`));
    }
  } else {
    console.log(chalk.red("✗ Proxy command NOT found"));
  }

  // Check if proxy is running
  const proxyRunning = await isProxyRunning();
  if (proxyRunning) {
    console.log(chalk.green("✓ Proxy is running"), chalk.gray("(127.0.0.1:8317)"));
  } else {
    console.log(chalk.red("✗ Proxy is NOT running"));
  }

  // Check auth status
  const auth = await checkAuthConfigured();
  console.log("");

  if (auth.hasModels) {
    console.log(chalk.green("✓ Auth: Models accessible (proxy has valid credentials)"));
  } else if (auth.hasAuthEntries) {
    console.log(chalk.yellow("⚠ Auth: Entries exist but models not accessible"));
  } else if (auth.hasAuthFiles) {
    console.log(chalk.yellow("⚠ Auth: Files exist but not loaded"));
  } else {
    console.log(chalk.red("✗ Auth: No credentials found"));
  }

  console.log("");
  console.log(chalk.gray("If you see errors above, try: npx -y @tuannvm/ccodex --login"));
}

/**
 * Preflight check - validate platform and capabilities before main operations
 * Only runs for non-status commands to allow read-only diagnostics anywhere
 */
function preflightOrThrow(): void {
  const platform = process.platform;
  const arch = process.arch;

  // Check Node.js version
  const nodeMajorVersion = Number(process.versions.node.split(".")[0]);
  if (nodeMajorVersion < 18) {
    throw new Error(
      `Node.js ${process.versions.node} detected.\n` +
        `Please use Node.js >= 18. You have ${process.versions.node}.`
    );
  }

  // Check OS support
  const supportedPlatforms = ["darwin", "linux", "win32"];
  if (!supportedPlatforms.includes(platform)) {
    throw new Error(
      `Unsupported OS: ${platform}\n` + `Supported platforms: ${supportedPlatforms.join(", ")}`
    );
  }

  // Check architecture for proxy auto-install (Unix/Linux only)
  if (platform === "darwin" || platform === "linux") {
    const supportedArches = ["arm64", "x64"];
    if (!supportedArches.includes(arch)) {
      throw new Error(
        `Unsupported architecture for CLIProxyAPI auto-install: ${arch}\n` +
          `Supported architectures: ${supportedArches.join(", ")}\n` +
          `CLIProxyAPI must be installed manually for your architecture.`
      );
    }
  }

  // Windows warning
  if (platform === "win32") {
    console.log(
      chalk.yellow(
        "Windows detected: CLIProxyAPI requires manual installation.\n" +
          "Install from: https://github.com/router-for-me/CLIProxyAPI/releases"
      )
    );
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
    console.log(chalk.yellow("Claude Code CLI not found. Installing..."));
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
  // Only run if not already configured for true idempotency
  const shellConfigured = await isShellIntegrationConfigured();
  if (!shellConfigured) {
    await configureShellIntegration();
    needsSetup = true;
  }

  // 5. Start proxy
  await startProxy();

  // 6. Check auth, launch login if needed
  const auth = await checkAuthConfigured();
  if (!auth.configured) {
    console.log(chalk.yellow("ChatGPT/Codex auth not configured. Starting login..."));
    await launchLogin();
    await waitForAuth();
    needsSetup = true;
  }

  if (needsSetup) {
    console.log("");
    await readyCheck();
    console.log("");
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("ccodex")
    .description("TypeScript reimplementation of ccodex - run Claude Code with OpenAI GPT models")
    .version(getVersion())
    .option("--login", "Run ChatGPT/Codex OAuth login")
    .option("--status", "Show setup status")
    .option("--diagnose", "Show proxy and auth diagnostics")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .parse(process.argv);

  const options = program.opts();

  // Preflight check for all operations except read-only diagnostics (--status, --diagnose)
  if (!options.status && !options.diagnose) {
    preflightOrThrow();
  }

  // Handle --login
  if (options.login) {
    // Ensure setup (installs dependencies, configures shell, starts proxy)
    // Skip the auth part of ensureSetup by checking first
    const claudeCmd = await detectClaudeCommand();
    if (!claudeCmd.cmd) {
      console.log(chalk.yellow("Claude Code CLI not found. Installing..."));
      await installClaudeCode();
    }

    const proxyCmd = await detectProxyCommand();
    if (!proxyCmd.cmd) {
      await installProxyApi();
    }

    // Only configure shell integration if not already configured
    const shellConfigured = await isShellIntegrationConfigured();
    if (!shellConfigured) {
      await configureShellIntegration();
    }
    await startProxy();

    // Check current auth status
    const authBefore = await checkAuthConfigured();
    if (authBefore.configured) {
      console.log(chalk.green("✓ Already authenticated. Launching login to re-authorize..."));
    } else {
      console.log(chalk.yellow("Not authenticated. Starting OAuth login flow..."));
    }

    // Launch login
    await launchLogin();

    // Wait for authentication to complete
    console.log("Waiting for OAuth authentication to complete...");
    await waitForAuth();

    // Verify auth worked
    const authAfter = await checkAuthConfigured();
    if (!authAfter.configured) {
      console.log(chalk.yellow("Authentication may not have completed. Please try:"));
      console.log("  1. Check if browser login completed");
      console.log("  2. Run: npx -y @tuannvm/ccodex --login");
      console.log("  3. Or restart the proxy and try again");
    } else {
      console.log(chalk.green("✓ Authentication successful! You can now use ccodex."));
    }
    return;
  }

  // Handle --status (read-only, no side effects)
  if (options.status) {
    await printStatus();
    return;
  }

  // Handle --diagnose (show detailed diagnostics)
  if (options.diagnose) {
    await showProxyDiagnostics();
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

  console.error(chalk.red("Error:"), err.message);

  // Suggest diagnostics for auth errors
  if (
    err.message.includes("401") ||
    err.message.includes("Invalid API key") ||
    err.message.includes("authentication")
  ) {
    console.error("");
    console.error(
      chalk.yellow("For troubleshooting, run:"),
      chalk.bold("npx -y @tuannvm/ccodex --diagnose")
    );
  }

  // Print stack trace in debug mode
  if (process.env.DEBUG || process.env.CCODEX_DEBUG) {
    console.error(chalk.gray(err.stack));
  }

  process.exit(1);
});
