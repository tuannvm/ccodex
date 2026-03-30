import { join, delimiter, normalize, sep, resolve, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import { spawnSync } from "child_process";
import chalk from "chalk";
import {
  hasCommand,
  getCommandPath,
  execCommand,
  httpGet,
  sleep,
  ensureDir,
  fileExists,
  safeJsonParse,
  debugLog,
  runCmdBounded,
  requireTrustedCommand,
  withInstallLock,
} from "./utils.js";
import { CONFIG, getProxyUrl, getAuthDir, getLogFilePath } from "./config.js";
import type { ProxyCommand, AuthStatus } from "./types.js";

// Track installed proxy binary path for this process
let installedProxyPath: string | null = null;

/**
 * Get allowed installation directories for proxy binary
 * Returns paths that are considered safe sources for CLIProxyAPI
 */
function getAllowedInstallDirs(): string[] {
  const home = homedir();
  const allowed: string[] = [
    join(home, ".local", "bin"), // User local bin
    "/usr/local/bin", // System local bin
    "/opt/homebrew/bin", // Homebrew Apple Silicon
    "/opt/homebrew/Cellar", // Homebrew Apple Silicon binaries
    "/home/linuxbrew/.linuxbrew/bin", // Homebrew Linux symlinks
    "/home/linuxbrew/.linuxbrew/Cellar", // Homebrew Linux binaries
    "/usr/local/Cellar", // Homebrew Intel binaries
    join(home, "go", "bin"), // Go user bin
  ];

  // Add common Windows paths if on Windows
  if (process.platform === "win32") {
    allowed.push(
      join(process.env.LOCALAPPDATA || "", "Programs"),
      join(process.env.APPDATA || "", "Programs")
    );
  }

  return allowed;
}

/**
 * Validate that a proxy binary path is from a trusted location
 * Throws if path is not absolute or not from allowed directory
 * Uses realpath to detect symlink escapes
 */
async function validateProxyPath(proxyPath: string): Promise<void> {
  if (!isAbsolute(proxyPath)) {
    throw new Error(`Proxy binary path is not absolute: ${proxyPath}`);
  }

  const fs = await import("fs/promises");
  // Use realpath to resolve symlinks and get the actual file location
  const realPath = await fs.realpath(proxyPath);
  const allowedDirs = getAllowedInstallDirs();

  const isAllowed = allowedDirs.some((allowedDir) => {
    const resolvedAllowed = resolve(allowedDir);
    return realPath.startsWith(resolvedAllowed + sep) || realPath === resolvedAllowed;
  });

  if (!isAllowed) {
    throw new Error(
      `Proxy binary not from trusted location.\n` +
        `Path: ${realPath}\n` +
        `Allowed directories: ${allowedDirs.join(", ")}\n\n` +
        `For security, only proxy binaries from trusted locations are executed.\n` +
        `If you installed CLIProxyAPI manually, move it to ~/.local/bin or install via Homebrew.`
    );
  }
}

/**
 * Get trusted proxy command path
 * Validates that the proxy binary is from a trusted location before execution
 */
export async function requireTrustedProxyCommand(): Promise<string> {
  const cmdResult = await detectProxyCommand();

  // Prefer installed path from this process
  if (installedProxyPath && fileExists(installedProxyPath)) {
    await validateProxyPath(installedProxyPath);
    return installedProxyPath;
  }

  // Use detected path
  if (!cmdResult.path) {
    throw new Error(
      "CLIProxyAPI not found. Install it first:\n" +
        "  1. Run: npx -y @tuannvm/ccodex\n" +
        "  2. Or install manually: brew install cliproxyapi"
    );
  }

  await validateProxyPath(cmdResult.path);
  return cmdResult.path;
}

/**
 * Detect CLIProxyAPI command
 * Prefers locally installed binary from this process if available
 * Supports multiple binary names: cli-proxy-api (new), CLIProxyAPI (old), cliproxy, cliproxyapi (Homebrew)
 */
export async function detectProxyCommand(): Promise<ProxyCommand> {
  // Prefer locally installed binary from this process
  if (installedProxyPath && fileExists(installedProxyPath)) {
    return { cmd: "cli-proxy-api", path: installedProxyPath };
  }

  // Try new name first, then legacy names
  const commandNames: ("cli-proxy-api" | "CLIProxyAPI" | "cliproxy" | "cliproxyapi")[] = [
    "cli-proxy-api",
    "CLIProxyAPI",
    "cliproxy",
    "cliproxyapi",
  ];
  for (const name of commandNames) {
    if (await hasCommand(name)) {
      const resolved = await getCommandPath(name);
      return { cmd: name, path: resolved };
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
 * Check if the running proxy accepts our sk-dummy api key.
 * Returns false if the proxy is running but was started without our config
 * (e.g. a stale process started before ccodex configured it).
 */
async function isProxyCompatible(): Promise<boolean> {
  try {
    const proxyUrl = getProxyUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${proxyUrl}/v1/models`, {
        headers: { Authorization: "Bearer sk-dummy" },
        signal: controller.signal,
      });
      // 200 = authenticated and has models, 401 = wrong upstream creds but key accepted
      // We treat both as compatible — the key is accepted by the proxy
      if (response.status === 401) {
        // Distinguish "proxy rejects our sk-dummy key" from "upstream credential 401".
        // Parse JSON error code/type — more robust than string matching message text.
        const body = await response.text();
        try {
          const json = JSON.parse(body) as {
            error?: { code?: string; type?: string; message?: string };
          };
          const code = json.error?.code ?? "";
          const type = json.error?.type ?? "";
          const msg = json.error?.message ?? "";
          const isKeyRejected =
            code === "invalid_api_key" ||
            code === "missing_api_key" ||
            msg.toLowerCase().includes("api key");
          void type; // type field alone is too broad to classify key rejection
          return !isKeyRejected;
        } catch {
          // Non-JSON 401 — treat as key rejected (fail-safe: don't reuse broken proxy)
          return false;
        }
      }
      return response.status === 200;
    } finally {
      clearTimeout(timeout);
    }
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
  const fs = await import("fs/promises");
  let hasAuthFiles = false;
  try {
    const files = await fs.readdir(authDir);
    hasAuthFiles = files.some((f) => f.startsWith("codex-") && f.endsWith(".json"));
  } catch {
    // Directory doesn't exist
    debugLog("Auth directory does not exist:", authDir);
  }

  // Check auth via proxy status
  let hasAuthEntries = false;
  try {
    const proxyExe = await requireTrustedProxyCommand();
    const output = await execCommand(proxyExe, ["status"], 5000);
    // Match "N auth entries" or "N auth files" where N > 0
    const match = output.match(/(\d+)\s+(auth entries|auth files)/);
    if (match) {
      const count = parseInt(match[1], 10);
      hasAuthEntries = count > 0;
    }
  } catch (error) {
    debugLog("Failed to check proxy status:", error);
  }

  // Check via API
  let hasModels = false;
  try {
    const proxyUrl = getProxyUrl();
    const response = await httpGet(`${proxyUrl}/v1/models`);
    if (response.status === 200) {
      const data = safeJsonParse<{ object: string; data: unknown[] }>(response.body);
      hasModels = data?.object === "list" && Array.isArray(data.data) && data.data.length > 0;
    }
  } catch {
    // Proxy not running or not authenticated
    debugLog("Failed to check models via API");
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
 * Parse checksum file to find expected hash for a specific file
 * Supports common checksum formats:
 * - SHA256SUMS: "a1b2c3...  filename" or "a1b2c3... *filename"
 * - checksums.txt: "a1b2c3... filename"
 * Handles path prefixes: "./filename", "subdir/filename", "subdir\filename" (Windows)
 * Prefers exact filename match over basename match to avoid collisions
 */
function parseExpectedSha256(content: string, fileName: string): string | null {
  // First pass: try exact filename match (with or without path separators)
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match: hash followed by whitespace and filename (with optional * prefix)
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) {
      const [, hash, name] = match;
      const normalizedName = name.trim();
      // Normalize path separators to / and strip any path prefix
      const normalizedBase = normalizedName.replace(/\\/g, "/").replace(/^.*\//, "");
      if (normalizedBase === fileName) {
        // Found exact basename match
        return hash.toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Fetch latest release info from GitHub API
 * Returns the exact tag name to avoid moving 'latest' redirects
 */
async function getLatestReleaseTag(): Promise<string> {
  const apiUrl = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "@tuannvm/ccodex",
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const data = await safeJsonParse<{ tag_name: string }>(await response.text());
    if (!data?.tag_name) {
      throw new Error("Invalid GitHub API response");
    }

    return data.tag_name;
  } catch (error) {
    debugLog("Failed to fetch latest release tag:", error);
    throw new Error(
      `Failed to resolve latest release tag from GitHub API: ${error instanceof Error ? error.message : String(error)}\n\n` +
        "Please check your internet connection or install CLIProxyAPI manually."
    );
  }
}

/**
 * Check if an archive entry path is unsafe (contains path traversal or absolute paths)
 */
function isUnsafeArchivePath(raw: string): boolean {
  if (!raw) return true;

  // Normalize zip/tar separators and strip leading "./"
  const p = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!p) return true;

  // Reject absolute, drive-letter, UNC-like
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p) || p.startsWith("//")) return true;

  // Reject traversal segments
  const parts = p.split("/").filter(Boolean);
  if (parts.some((seg) => seg === "..")) return true;

  return false;
}

// Resource limits for archive extraction (prevent tar/zip bombs)
const MAX_ENTRIES = 1000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100 MB compressed
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024; // 500 MB uncompressed

/**
 * Parse tar verbose output line to extract path and type
 * Handles GNU/BSD tar verbose output with special bits and spaces in filenames
 * Returns null for lines that don't match expected tar verbose format (treated as suspicious)
 */
function parseTarVerboseLine(line: string): {
  path: string;
  type: "file" | "dir" | "symlink" | "hardlink" | "char" | "block" | "fifo" | "other";
} | null {
  // Tar verbose format typically:
  // permissions owner/group size date time... path
  // Or with links: permissions ... path -> target
  //
  // We parse by:
  // 1. Finding the path segment (everything after the date/time)
  // 2. Checking the first character for file type
  //
  // Handle special bits that may appear: s/S (setuid/setgid), t/T (sticky), + (ACL), @ (extended attributes)
  // The first character indicates type: - (file), d (dir), l (symlink), h (hardlink), c (char), b (block), p (fifo)

  if (!line || line.length === 0) return null;

  const firstChar = line.charAt(0);
  const fileTypeMap: Record<
    string,
    "file" | "dir" | "symlink" | "hardlink" | "char" | "block" | "fifo" | "other"
  > = {
    "-": "file",
    d: "dir",
    l: "symlink",
    h: "hardlink",
    c: "char",
    b: "block",
    p: "fifo",
  };

  const type = fileTypeMap[firstChar];
  if (!type) {
    // Unknown file type character - treat as suspicious
    return null;
  }

  // Find the path by splitting on whitespace
  // Tar verbose format fields are separated by whitespace
  // The path is typically the last field (or second-to-last before "-> target")
  const parts = line.split(/\s+/);

  // For very long lines with many fields, the path might be split further
  // Find the part that looks like a path (contains '/', or ends with ' -> ', or is just a name)
  let pathWithTarget = "";
  let foundPath = false;

  // Iterate from the end to find the path
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.includes("/") || part.includes(" -> ") || (part.length > 0 && !foundPath)) {
      pathWithTarget = part + (pathWithTarget ? " " + pathWithTarget : "");
      foundPath = true;
    } else if (foundPath) {
      // We've collected all path parts
      break;
    }
  }

  if (!pathWithTarget) return null;

  // Extract just the path (before " -> " for symlinks)
  const arrowIndex = pathWithTarget.indexOf(" -> ");
  const path =
    arrowIndex >= 0 ? pathWithTarget.substring(0, arrowIndex).trim() : pathWithTarget.trim();

  if (!path) return null;

  return { path, type };
}

/**
 * List entries in a tar archive with resource limits and link type validation
 */
async function listTarEntries(archivePath: string): Promise<string[]> {
  const fs = await import("fs/promises");

  // Check archive file size before extraction
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Archive file is too large (${(archiveStat.size / 1024 / 1024).toFixed(1)} MB > ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB). ` +
        "This may be a tar bomb."
    );
  }

  // Use verbose mode with -z to explicitly handle gzip compression
  // Some tar versions auto-detect compression, but -z ensures consistency
  // Use trusted tar path to avoid PATH hijacking
  const tarPath = await requireTrustedCommand("tar");
  const result = await runCmdBounded(tarPath, ["-ztvf", archivePath], 30000); // 30 second timeout
  if (result.code !== 0) {
    throw new Error(`tar list failed with code ${result.code}`);
  }

  const lines = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: string[] = [];

  // Resource limits: prevent tar/zip bombs
  if (lines.length > MAX_ENTRIES) {
    throw new Error(
      `Archive has too many entries (${lines.length} > ${MAX_ENTRIES}). This may be a tar bomb.`
    );
  }

  // Parse and validate each entry
  for (const line of lines) {
    const parsed = parseTarVerboseLine(line);
    // Treat unparsable lines as suspicious - fail closed instead of skipping
    if (!parsed) {
      throw new Error(
        `Unrecognized tar output format (possible archive corruption): ${line.substring(0, 100)}`
      );
    }

    // Check for unsafe paths
    if (isUnsafeArchivePath(parsed.path)) {
      throw new Error(`Unsafe archive path: ${parsed.path}`);
    }

    // Reject symlinks and hardlinks for security
    if (parsed.type === "symlink" || parsed.type === "hardlink") {
      throw new Error(`Archive contains forbidden link entry: ${parsed.path} (${parsed.type})`);
    }

    // Reject character/block devices, fifos (unusual in CLIProxyAPI archives)
    if (parsed.type === "char" || parsed.type === "block" || parsed.type === "fifo") {
      throw new Error(`Archive contains unusual entry type: ${parsed.path} (${parsed.type})`);
    }

    entries.push(parsed.path);
  }

  if (entries.length === 0) {
    throw new Error("Archive is empty or contains no valid entries");
  }

  return entries;
}

/**
 * Compute directory size recursively
 */
async function getDirSize(dir: string, fs: typeof import("fs/promises")): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let size = 0;
  for (const ent of entries) {
    const full = join(dir, ent.name);
    const stat = await fs.stat(full);
    if (ent.isDirectory()) {
      size += await getDirSize(full, fs);
    } else {
      size += stat.size;
    }
  }
  return size;
}

/**
 * Validate archive listing for unsafe paths and link types
 * Note: Windows installation is not currently supported (throws early in installProxyApi)
 */
async function validateArchiveListing(archivePath: string): Promise<void> {
  // listTarEntries now does all the validation (path safety, link rejection, resource limits)
  await listTarEntries(archivePath);
}

/**
 * Assert that all extracted files are confined within the target directory
 * Validates that realpath of all files stays within the target directory
 * Symlinks and hardlinks are already rejected during tar parsing
 */
async function assertRealpathConfinement(rootDir: string): Promise<void> {
  const fs = await import("fs/promises");
  const rootReal = await fs.realpath(rootDir);
  const stack = [rootDir];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = await fs.readdir(cur, { withFileTypes: true });

    for (const ent of entries) {
      const full = join(cur, ent.name);

      // Double-check for symlinks (defensive: should have been caught during tar parsing)
      const lst = await fs.lstat(full);
      if (lst.isSymbolicLink()) {
        throw new Error(`Symlink not allowed in extracted archive: ${full}`);
      }

      // Verify realpath stays within target directory
      const rp = await fs.realpath(full);
      const confined = rp === rootReal || rp.startsWith(rootReal + sep);
      if (!confined) {
        throw new Error(`Extracted path escapes target directory: ${full}`);
      }

      if (ent.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

/**
 * Install CLIProxyAPI via Homebrew or Go binary fallback
 */
export async function installProxyApi(): Promise<void> {
  const { homedir } = await import("os");
  const home = homedir();
  if (!home) {
    throw new Error("Cannot determine home directory. Please set HOME environment variable.");
  }

  // Install lock file path (in the target install directory)
  const lockPath = join(home, ".local", "bin", ".cli-proxy-api.install.lock");

  // Check platform
  const platform = process.platform as string;
  const arch = process.arch;

  if (platform === "win32") {
    throw new Error(
      "CLIProxyAPI installation on Windows requires manual setup.\n" +
        "Please install CLIProxyAPI manually and ensure it's in your PATH.\n" +
        "See CLIProxyAPI documentation for Windows installation instructions."
    );
  }

  // Ensure lock directory exists before acquiring lock
  const installDir = join(home, ".local", "bin");
  await ensureDir(installDir);

  // Wrap entire installation process (both Homebrew and Go binary paths) in lock
  await withInstallLock(lockPath, async () => {
    // Try Homebrew first (preferred)
    if (await hasCommand("brew")) {
      console.log("Installing CLIProxyAPI via Homebrew...");

      const brewPath = await requireTrustedCommand("brew");
      const spawnCmd = (await import("cross-spawn")).default;
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawnCmd(brewPath, ["install", "cliproxyapi"], {
            stdio: "inherit",
          });

          child.on("close", (code: number | null) => {
            if (code === 0) {
              console.log("CLIProxyAPI installed successfully via Homebrew");
              resolve();
            } else {
              reject(new Error("Failed to install CLIProxyAPI via Homebrew"));
            }
          });

          child.on("error", (error: Error) => reject(error));
        });
        return;
      } catch (error) {
        debugLog("Homebrew installation failed, falling back to Go binary:", error);
        // Fall through to Go binary installation
      }
    }

    // Fallback: Install Go binary directly
    console.log("Installing CLIProxyAPI via Go binary...");

    // Determine platform/arch for CLIProxyAPI release asset format
    // CLIProxyAPI uses: CLIProxyAPI_{version}_{platform}_{arch}.{ext}
    const platformMap: Record<string, string> = {
      darwin: "darwin",
      linux: "linux",
      win32: "windows",
    };
    const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };

    const cliPlatform = platformMap[platform];
    const cliArch = archMap[arch];

    if (!cliPlatform) {
      throw new Error(
        `Unsupported platform: ${platform}\n` +
          `Supported platforms: ${Object.keys(platformMap).join(", ")}`
      );
    }

    if (!cliArch) {
      throw new Error(
        `Unsupported architecture: ${arch}\n` +
          `Supported architectures: ${Object.keys(archMap).join(", ")}`
      );
    }

    // Resolve exact release tag first for security (avoid moving 'latest' redirects)
    console.log("Resolving latest release tag from GitHub API...");
    const releaseTag = await getLatestReleaseTag();
    console.log(`Latest release: ${releaseTag}`);

    // Strip 'v' prefix from tag for version (e.g., v6.9.5 -> 6.9.5)
    const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;

    // Determine archive extension
    const isWindows = platform === "win32";
    const archiveExt = isWindows ? "zip" : "tar.gz";
    const archiveFileName = `CLIProxyAPI_${version}_${cliPlatform}_${cliArch}.${archiveExt}`;

    // installDir is already defined and ensured at function start
    const binaryName = isWindows ? "cli-proxy-api.exe" : "cli-proxy-api";
    const binaryPath = join(installDir, binaryName);
    // Use crypto.randomUUID() for temp files to avoid collision in concurrent installs
    const randomSuffix = randomUUID();
    const archivePath = join(installDir, `cli-proxy-api-${randomSuffix}.${archiveExt}`);
    const extractDir = join(installDir, `cli-proxy-api-extract-${randomSuffix}`);

    const baseUrl = `https://github.com/router-for-me/CLIProxyAPI/releases/download/${releaseTag}`;
    const archiveUrl = `${baseUrl}/${archiveFileName}`;

    console.log(`Downloading ${archiveFileName} from GitHub releases...`);

    const fs = await import("fs/promises");

    try {
      // Download archive with streaming and byte limits
      console.log(`Downloading ${archiveFileName} from GitHub releases...`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 120 second timeout

      let response: Response;
      try {
        response = await fetch(archiveUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        if (response.status === 404) {
          // 404 means the archive doesn't exist for this platform/arch in this release
          throw new Error(
            `Archive not found for ${cliPlatform}_${cliArch}\n` +
              `URL: ${archiveUrl}\n\n` +
              `This could mean:\n` +
              `  - ${cliPlatform}_${cliArch} archives are not available in release ${releaseTag}\n` +
              `  - Check the CLIProxyAPI releases page for available platforms\n\n` +
              `Suggested alternatives:\n` +
              `  1. Try Homebrew installation: brew install cliproxyapi\n` +
              `  2. Check available releases: ${baseUrl}\n` +
              `  3. Download manually from: https://github.com/router-for-me/CLIProxyAPI/releases\n\n` +
              `Available platforms for CLIProxyAPI may vary by release.`
          );
        }
        throw new Error(
          `HTTP ${response.status} ${response.statusText}\n` +
            `URL: ${archiveUrl}\n` +
            `Platform/Arch: ${cliPlatform}_${cliArch}`
        );
      }

      // Pre-check content-length if available
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `Archive too large (Content-Length: ${(contentLength / 1024 / 1024).toFixed(1)} MB > ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB). ` +
            "This may be a tar bomb."
        );
      }

      // Stream download with byte limit and incremental hash
      if (!response.body) {
        throw new Error("Response body is null");
      }

      const fileHandle = await fs.open(archivePath, "w");
      const hash = createHash("sha256");
      let downloadedBytes = 0;

      try {
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          downloadedBytes += chunk.byteLength;
          if (downloadedBytes > MAX_ARCHIVE_BYTES) {
            throw new Error(
              `Archive exceeded size limit during download (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB > ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB). ` +
                "This may be a tar bomb."
            );
          }
          hash.update(chunk);
          await fileHandle.write(chunk);
        }
      } finally {
        await fileHandle.close();
      }

      console.log(`Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB`);

      // Get the calculated hash
      const actualHash = hash.digest("hex");

      // Try to download and verify checksums file
      let checksumVerified = false;
      let checksumMismatchError: Error | null = null;
      const checksumUrls = [
        `${baseUrl}/SHA256SUMS`,
        `${baseUrl}/checksums.txt`,
        `${baseUrl}/checksums.sha256`,
      ];

      for (const checksumUrl of checksumUrls) {
        try {
          console.log(`Attempting checksum verification from: ${new URL(checksumUrl).pathname}`);
          const checksumResponse = await fetch(checksumUrl, { signal: AbortSignal.timeout(10000) });

          if (checksumResponse.ok) {
            const checksumContent = await checksumResponse.text();
            const expectedHash = parseExpectedSha256(checksumContent, archiveFileName);

            if (expectedHash) {
              if (actualHash === expectedHash) {
                console.log(chalk.green("✓ Checksum verification passed"));
                checksumVerified = true;
                break;
              } else {
                // Checksum mismatch - this is FATAL, do not continue
                await fs.unlink(archivePath).catch(() => {});
                checksumMismatchError = new Error(
                  `Checksum verification failed!\n` +
                    `Expected: ${expectedHash}\n` +
                    `Actual:   ${actualHash}\n\n` +
                    `The downloaded archive may be corrupted or tampered with.\n` +
                    `Please try again or install CLIProxyAPI manually.`
                );
                break; // Exit loop immediately on mismatch
              }
            }
          }
        } catch (checksumError) {
          // Only catch network/parsing errors - let checksum mismatches fail hard
          const errorMsg =
            checksumError instanceof Error ? checksumError.message : String(checksumError);
          if (errorMsg.includes("Checksum verification failed")) {
            // Re-throw checksum mismatch errors
            throw checksumError;
          }
          debugLog(`Checksum verification failed for ${checksumUrl}:`, checksumError);
          // Try next checksum URL on network errors
        }
      }

      // If we found a checksum mismatch, fail hard
      if (checksumMismatchError) {
        throw checksumMismatchError;
      }

      // SECURITY: Fail closed if checksum verification is not available
      // This prevents installation of potentially tampered binaries
      if (!checksumVerified) {
        await fs.unlink(archivePath).catch(() => {});
        throw new Error(
          chalk.red("Checksum verification required but failed.\n\n") +
            "The downloaded archive could not be verified against a checksum file.\n" +
            "This is a security requirement to prevent installation of tampered binaries.\n\n" +
            "Possible reasons:\n" +
            "  - Network issues prevented checksum file download\n" +
            "  - Checksum files are not published for this release\n" +
            "  - GitHub releases are temporarily unavailable\n\n" +
            "To install CLIProxyAPI safely:\n" +
            `  1. Visit ${baseUrl}/\n` +
            "  2. Download the archive and checksum files manually\n" +
            "  3. Verify the checksums match\n" +
            "  4. Extract the archive\n" +
            "  5. Place the binary in a directory in your PATH\n" +
            "  6. Make it executable: chmod +x cli-proxy-api\n\n" +
            "Then run ccodex again."
        );
      }

      // Archive was already written to disk during streaming download

      // Extract archive using hardened extraction strategy
      console.log(`Extracting ${archiveExt} archive...`);
      await ensureDir(extractDir);

      // Preflight: validate archive listing before extraction
      console.log("Validating archive contents...");
      await validateArchiveListing(archivePath);

      try {
        // Unix/macOS: use tar with portable hardened flags
        // Note: --no-same-owner and --no-same-permissions are supported by both GNU and BSD tar
        // We avoid GNU-specific flags like --delay-directory-restore for macOS compatibility
        // Use bounded execution with timeout (60 seconds for extraction) and trusted tar path
        const tarPath = await requireTrustedCommand("tar");
        const result = await runCmdBounded(
          tarPath,
          ["-xzf", archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"],
          60000
        );
        if (result.code !== 0) {
          throw new Error(`tar extraction failed with code ${result.code}`);
        }
      } catch (extractError) {
        // Clean up on extraction failure
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Failed to extract archive: ${extractError instanceof Error ? extractError.message : String(extractError)}\n\n` +
            "The archive may be corrupted or incompatible with your system."
        );
      }

      // Post-extraction: validate extracted size (prevent zip bomb)
      console.log("Validating extracted size...");
      let extractedBytes = 0;
      try {
        extractedBytes = await getDirSize(extractDir, fs);
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error(
            `Extracted content is too large (${(extractedBytes / 1024 / 1024).toFixed(1)} MB > ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB). ` +
              "This may be a zip bomb."
          );
        }
      } catch (sizeError) {
        // Clean up on size check failure
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw sizeError;
      }

      // Post-extraction: validate realpath confinement
      // This detects path traversal via symlinks, hardlinks, or other escape mechanisms
      console.log("Validating extraction safety...");
      try {
        await assertRealpathConfinement(extractDir);
      } catch (confinementError) {
        // Clean up on confinement failure
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw confinementError;
      }

      // Find the extracted binary
      // CLIProxyAPI archives contain a binary named 'cli-proxy-api' (new), 'CLIProxyAPI' (old), or 'cliproxyapi' (Homebrew tap)
      // On Windows it may have .exe extension
      const extractedFiles = await fs.readdir(extractDir);
      const binaryNames = isWindows
        ? ["cli-proxy-api.exe", "CLIProxyAPI.exe", "cliproxyapi.exe"]
        : ["cli-proxy-api", "CLIProxyAPI", "cliproxyapi"];
      const extractedBinary = extractedFiles.find((f) => binaryNames.includes(f));

      if (!extractedBinary) {
        // Clean up
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Could not find CLIProxyAPI binary in extracted archive.\n` +
            `Files found: ${extractedFiles.join(", ")}\n\n` +
            "The archive format may have changed. Please report this issue."
        );
      }

      const extractedBinaryPath = join(extractDir, extractedBinary);

      // Set executable permission on extracted binary before validation (Unix/macOS only)
      if (!isWindows) {
        try {
          await fs.chmod(extractedBinaryPath, 0o755);
        } catch (chmodError) {
          debugLog("Warning: Could not set executable permission on extracted binary:", chmodError);
          // Continue anyway - the archive may already have execute bits set
        }
      }

      // Validate the extracted binary works by running it
      console.log("Validating extracted binary...");
      try {
        // Try multiple version flags that the binary might support
        const versionFlags = [["--version"], ["-v"], ["version"]];
        let success = false;

        for (const args of versionFlags) {
          try {
            const testResult = await runCmdBounded(extractedBinaryPath, args, 5000);
            if (testResult.code === 0) {
              success = true;
              debugLog(`Binary validated with flag: ${args[0]}`);
              break;
            }
          } catch {
            // Try next flag
            continue;
          }
        }

        // If all version flags failed, try running without arguments (may show usage)
        if (!success) {
          const testResult = await runCmdBounded(extractedBinaryPath, [], 3000);
          // If it runs at all (even with usage error), consider it valid
          if (testResult.code === 0 || testResult.code === 2) {
            debugLog("Binary validated (executable but may not support --version flag)");
            success = true;
          }
        }

        if (!success) {
          throw new Error(`Binary validation failed: all test attempts failed`);
        }
      } catch (validationError) {
        // Clean up invalid binary
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Extracted binary failed validation: ${validationError instanceof Error ? validationError.message : String(validationError)}\n\n` +
            "The binary may be corrupted or incompatible with your system."
        );
      }

      // Backup existing binary if present, but be ready to rollback
      let backupPath: string | null = null;
      let didBackup = false;
      if (await fileExists(binaryPath)) {
        backupPath = `${binaryPath}.backup.${randomUUID()}`;
        await fs.rename(binaryPath, backupPath);
        didBackup = true;
      }

      // Copy extracted binary to final location
      try {
        await fs.copyFile(extractedBinaryPath, binaryPath);
        // Set executable permission on Unix/macOS
        if (!isWindows) {
          await fs.chmod(binaryPath, 0o755);
        }
        // Store the installed path for this process
        installedProxyPath = binaryPath;
      } catch (copyError) {
        // Rollback: restore backup if we had one
        if (didBackup && backupPath) {
          try {
            await fs.rename(backupPath, binaryPath);
          } catch (rollbackError) {
            debugLog("Failed to rollback after copy failure:", rollbackError);
          }
        }
        // Clean up
        await fs.unlink(archivePath).catch(() => {});
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Failed to copy binary to final location: ${copyError instanceof Error ? copyError.message : String(copyError)}`
        );
      }

      // Clean up on success
      await fs.unlink(archivePath).catch((err) => {
        debugLog("Warning: Failed to cleanup archive file:", err);
      });
      await fs.rm(extractDir, { recursive: true, force: true }).catch((err) => {
        debugLog("Warning: Failed to cleanup extract directory:", err);
      });

      // Clean up backup on success
      if (backupPath) {
        await fs.unlink(backupPath).catch((err) => {
          debugLog("Warning: Failed to cleanup backup file:", err);
        });
      }

      console.log(`CLIProxyAPI installed successfully to: ${binaryPath}`);

      // Check if install dir is in PATH (use platform-specific delimiter and case-insensitive on Windows)
      const pathEnv = process.env.PATH || "";
      // Filter empty segments to avoid false positives from '::' in PATH
      const pathDirs = pathEnv.split(delimiter).filter((p) => p.length > 0);
      // Normalize paths for comparison: resolve to absolute paths, normalize separators, case-insensitive on Windows
      const normalizePath = (p: string) => {
        const resolved = resolve(p);
        const normalized = normalize(resolved);
        return isWindows ? normalized.toLowerCase() : normalized;
      };
      const binInPath = pathDirs.some((dir) => normalizePath(dir) === normalizePath(installDir));

      if (!binInPath) {
        console.log("");
        console.log("⚠️  WARNING: ~/.local/bin is not in your PATH");
        console.log("");
        console.log("To use ccodex, add ~/.local/bin to your PATH:");
        console.log("");
        console.log("  For bash (add to ~/.bashrc):");
        console.log('    export PATH="$HOME/.local/bin:$PATH"');
        console.log("");
        console.log("  For zsh (add to ~/.zshrc):");
        console.log('    export PATH="$HOME/.local/bin:$PATH"');
        console.log("");
        console.log("Then reload your shell: source ~/.bashrc (or ~/.zshrc)");
      }
    } catch (error) {
      // Clean up archive and extract dir on error
      await fs.unlink(archivePath).catch((err) => {
        debugLog("Warning: Failed to cleanup archive file during error handling:", err);
      });
      await fs.rm(extractDir, { recursive: true, force: true }).catch((err) => {
        debugLog("Warning: Failed to cleanup extract directory during error handling:", err);
      });

      throw new Error(
        `Failed to install CLIProxyAPI: ${error instanceof Error ? error.message : String(error)}\n\n` +
          "Please install CLIProxyAPI manually:\n" +
          "  1. Visit https://github.com/router-for-me/CLIProxyAPI/releases\n" +
          `  2. Download ${archiveFileName} for your system\n` +
          "  3. Extract the archive\n" +
          "  4. Place the binary in a directory in your PATH\n" +
          "  5. Make it executable: chmod +x cli-proxy-api"
      );
    }
  });
}

/**
 * Kill any running CLIProxyAPI process (cross-platform).
 * On Unix: tries pkill, then falls back to lsof-based port kill.
 * On Windows: uses taskkill.
 * Swallows errors — it's fine if no process is found.
 */
async function killProxy(): Promise<void> {
  const { execSync } = await import("child_process");
  if (process.platform === "win32") {
    try {
      execSync("taskkill /F /IM cli-proxy-api.exe /T", { stdio: "ignore" });
    } catch {
      // No matching process — ignore
    }
    return;
  }
  // Unix: try pkill by name, then always run lsof port-kill as a secondary guard.
  // The lsof pass catches any process holding the port even if pkill missed it
  // (e.g., pkill not installed on minimal systems, or process renamed).
  try {
    execSync("pkill -f 'cli-proxy-api|CLIProxyAPI|cliproxyapi'", { stdio: "ignore" });
  } catch {
    // pkill not found (ENOENT) or no matching process (exit 1) — both are ignorable
  }
  try {
    execSync(`lsof -ti :${CONFIG.PROXY_PORT} | xargs kill -9`, { stdio: "ignore", shell: "/bin/sh" });
  } catch {
    // lsof not found or no process on port — ignore
  }
}

/**
 * Start proxy in background
 */
export async function startProxy(): Promise<void> {
  if (await isProxyRunning()) {
    // Proxy is up — verify it accepts our sk-dummy key.
    // A stale proxy started without our config will reject it.
    if (!(await isProxyCompatible())) {
      console.log("Restarting CLIProxyAPI (incompatible config, killing stale process)...");
      await killProxy();
      // Wait for port to free up
      await sleep(1500);
    } else {
      return;
    }
  }

  const proxyExe = await requireTrustedProxyCommand();

  console.log("Starting CLIProxyAPI in background...");

  const { homedir } = await import("os");
  const home = homedir();
  const logFile = getLogFilePath();
  await ensureDir(dirname(logFile));

  const { spawn } = await import("child_process");
  const fs = await import("fs/promises");

  let out: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    // Create log with restrictive permissions (user read/write only)
    out = await fs.open(logFile, "a");

    // Set restrictive permissions on Unix/macOS (0600 = user read/write only)
    if (process.platform !== "win32") {
      try {
        await fs.chmod(logFile, 0o600);
      } catch {
        // If chmod fails, continue anyway - the file was created successfully
        debugLog("Warning: Could not set restrictive permissions on log file");
      }
    }

    // Determine config file location
    // CLIProxyAPI uses -config flag to specify config file path
    // Without -config, it looks for config.yaml in current working directory
    const configDir = join(home, ".config", "ccodex");
    await ensureDir(configDir);
    const configPath = join(configDir, "config.yaml");

    // Use the same auth directory as the rest of ccodex
    const authDir = getAuthDir();

    // Create or repair config to ensure auth_dir is always valid
    if (!(await fileExists(configPath))) {
      await fs.writeFile(
        configPath,
        `# CLIProxyAPI configuration
# Generated by ccodex

host: 127.0.0.1
port: 8317

api-keys:
  - "sk-dummy"

auth-dir: ${authDir}

debug: false
logging-to-file: false
`,
        "utf-8"
      );
      debugLog(`Created default config: ${configPath}`);
    } else {
      // Repair existing config if auth-dir or api-keys is missing
      // Also migrate legacy auth_dir (underscore) to auth-dir (hyphen)
      const configRaw = await fs.readFile(configPath, "utf-8");

      // Check for both auth-dir (correct) and auth_dir (legacy/incorrect)
      const authDirLine = /^(\s*auth-dir\s*:\s*)(.*)$/m.exec(configRaw);
      const legacyAuthDirLine = /^(\s*auth_dir\s*:\s*)(.*)$/m.exec(configRaw);
      const apiKeysLine = /^\s*api-keys\s*:/m.exec(configRaw);
      const configuredAuthDir = authDirLine?.[2]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
      const { isAbsolute } = await import("path");
      const needsAuthDirRepair = configuredAuthDir.length === 0 || !isAbsolute(configuredAuthDir);
      const needsApiKeysRepair = !apiKeysLine;

      // Check for invalid log.level field (CLIProxyAPI uses debug: false, not log.level)
      const hasInvalidLogLevel = /^\s*log\s*:\s*\n\s*level\s*:/m.test(configRaw);

      if (needsAuthDirRepair || legacyAuthDirLine || needsApiKeysRepair || hasInvalidLogLevel) {
        let repairedConfig = configRaw;

        // Remove legacy auth_dir line if present
        if (legacyAuthDirLine) {
          repairedConfig = repairedConfig.replace(/^(\s*auth_dir\s*:\s*).*$/m, "");
          debugLog(`Removed legacy auth_dir key from config: ${configPath}`);
        }

        // Add api-keys if missing
        if (needsApiKeysRepair) {
          // Insert api-keys after port line or at the top if port not found
          const portLineMatch = /^(\s*port\s*:\s*\d+\s*)$/m.exec(repairedConfig);
          if (portLineMatch) {
            repairedConfig = repairedConfig.replace(
              /^(\s*port\s*:\s*\d+\s*)$/m,
              `$1\n\napi-keys:\n  - "sk-dummy"`
            );
          } else {
            // Insert at the beginning after host line
            const hostLineMatch = /^(\s*host\s*:.*)$/m.exec(repairedConfig);
            if (hostLineMatch) {
              repairedConfig = repairedConfig.replace(
                /^(\s*host\s*:.*)$/m,
                `$1\n\napi-keys:\n  - "sk-dummy"`
              );
            } else {
              repairedConfig = `api-keys:\n  - "sk-dummy"\n\n${repairedConfig}`;
            }
          }
          debugLog(`Added api-keys to config: ${configPath}`);
        }

        // Repair invalid log.level field (replace with debug: false)
        if (hasInvalidLogLevel) {
          // Remove the entire log: block with level:
          repairedConfig = repairedConfig.replace(/^\s*log\s*:\s*\n\s*level\s*:\s*\w+\s*\n?/m, "");
          // Add debug: false and logging-to-file: false if not already present
          if (!/^\s*debug\s*:/m.test(repairedConfig)) {
            repairedConfig = `${repairedConfig.trimEnd()}\ndebug: false\nlogging-to-file: false\n`;
          }
          debugLog(`Repaired invalid log.level field in config: ${configPath}`);
        }

        // Update or add auth-dir line
        const existingAuthDirLine = /^(\s*auth-dir\s*:\s*)(.*)$/m.exec(repairedConfig);
        if (existingAuthDirLine) {
          repairedConfig = repairedConfig.replace(/^(\s*auth-dir\s*:\s*).*$/m, `$1${authDir}`);
        } else {
          repairedConfig = `${repairedConfig.trimEnd()}\nauth-dir: ${authDir}\n`;
        }

        await fs.writeFile(configPath, repairedConfig, "utf-8");
        debugLog(`Repaired config: ${configPath}`);
      }
    }

    // Also update merged-config.yaml if it exists (for VibeProxy users)
    // This ensures compatibility with users who have VibeProxy installed
    const mergedConfigPath = join(authDir, "merged-config.yaml");
    if (await fileExists(mergedConfigPath)) {
      const mergedRaw = await fs.readFile(mergedConfigPath, "utf-8");
      const hasApiKeys = /^\s*api-keys\s*:/m.test(mergedRaw);

      if (!hasApiKeys) {
        let repairedMerged = mergedRaw;
        // Insert api-keys after auth-dir line or at the beginning
        const authDirMatch = /^(\s*auth-dir\s*:.*)$/m.exec(repairedMerged);
        if (authDirMatch) {
          repairedMerged = repairedMerged.replace(
            /^(\s*auth-dir\s*:.*)$/m,
            `$1\n\napi-keys:\n  - "sk-dummy"`
          );
        } else {
          repairedMerged = `${repairedMerged.trimEnd()}\n\napi-keys:\n  - "sk-dummy"\n`;
        }
        await fs.writeFile(mergedConfigPath, repairedMerged, "utf-8");
        debugLog(`Added api-keys to merged-config.yaml for VibeProxy compatibility`);
      }
    }

    // Ensure auth directory exists before spawning CLIProxyAPI
    await ensureDir(authDir);

    // Pass config path via -config flag to CLIProxyAPI
    // Include explicit PATH for container environments where it may be missing
    const childEnv = {
      ...process.env,
      HOME: home,
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    };

    const child = spawn(proxyExe, ["-config", configPath], {
      detached: true,
      stdio: ["ignore", out.fd, out.fd],
      env: childEnv,
    });

    // Handle spawn errors immediately (fail-fast)
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error: Error) => {
        reject(new Error(`Failed to start CLIProxyAPI: ${error.message}`));
      });
      child.once("spawn", () => resolve());
    });

    child.unref();

    // Wait for proxy to be ready
    for (let i = 0; i < CONFIG.PROXY_STARTUP_MAX_RETRIES; i++) {
      await sleep(CONFIG.PROXY_STARTUP_RETRY_DELAY_MS);
      if (await isProxyRunning()) {
        console.log("CLIProxyAPI is running.");
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
  const proxyExe = await requireTrustedProxyCommand();

  console.log("Launching ChatGPT/Codex OAuth login...");

  const { homedir } = await import("os");
  const home = homedir();
  const configDir = join(home, ".config", "ccodex");
  const configPath = join(configDir, "config.yaml");

  // Ensure config exists
  const authDir = getAuthDir();
  await ensureDir(authDir);
  if (!(await fileExists(configPath))) {
    // Config should exist from startProxy, but create if missing
    const fs = await import("fs/promises");
    await fs.writeFile(configPath, `# CLIProxyAPI configuration
# Generated by ccodex

host: 127.0.0.1
port: 8317

auth-dir: ${authDir}

log:
  level: info
`, "utf-8");
  }

  const spawnCmd = (await import("cross-spawn")).default;

  // Use -no-browser flag to get URL output directly
  // Capture stdout to extract OAuth URL if present
  return new Promise<void>((resolve, reject) => {
    const child = spawnCmd(proxyExe, ["-config", configPath, "-codex-login", "-no-browser"], {
      stdio: ["ignore", "pipe", "inherit"], // Capture stdout, let stderr go to terminal
      env: { ...process.env, HOME: home },
    });

    let output = "";
    let oauthUrl: string | null = null;
    let keypressCleanup: (() => void) | null = null;
    // Carry buffer for incomplete lines spanning chunk boundaries
    let lineBuffer = "";

    const setupCopyPrompt = (url: string): void => {
      if (oauthUrl) return; // already set up
      oauthUrl = url;
      console.log(`\nBrowser didn't open? Use the url below to sign in (c to copy)\n  ${url}\n`);

      // Listen for 'c' keypress to copy URL to clipboard
      if (process.stdin.isTTY) {
        let rawModeEnabled = false;
        try {
          process.stdin.setRawMode(true);
          rawModeEnabled = true;
          process.stdin.resume();
          process.stdin.setEncoding("utf8");

          const onKey = (key: string): void => {
            if (key === "c" || key === "C") {
              copyToClipboard(url);
              console.log("  Copied!");
            } else if (key === "\u0003") {
              // Ctrl+C — let it propagate
              process.kill(process.pid, "SIGINT");
            }
          };

          process.stdin.on("data", onKey);
          keypressCleanup = (): void => {
            process.stdin.off("data", onKey);
            try {
              if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
              }
            } catch {
              // ignore cleanup errors
            }
          };
        } catch {
          // setRawMode failed — restore if it was partially set
          if (rawModeEnabled) {
            try { process.stdin.setRawMode(false); } catch { /* ignore */ }
          }
          // Copy prompt still shown on screen, keypress just won't work
        }
      }
    };

    const processLine = (line: string): void => {
      // Match any https URL (broad: covers any OAuth provider)
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch && !oauthUrl) {
        setupCopyPrompt(urlMatch[0]);
      } else {
        process.stdout.write(line + "\n");
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      // Buffer incomplete lines across chunks to handle URLs that span chunk boundaries
      const combined = lineBuffer + text;
      const lines = combined.split("\n");
      // Last element is either empty (text ended with \n) or an incomplete line fragment
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.on("close", (code: number | null) => {
      // Flush any remaining buffered line
      if (lineBuffer) processLine(lineBuffer);
      keypressCleanup?.();
      if (code === 0) {
        resolve();
      } else {
        // Surface the URL if login failed without a browser visit
        const urlMatch = output.match(/https?:\/\/[^\s\n]+/);
        if (urlMatch && !oauthUrl) {
          console.log(`\n🔐 Visit this URL to complete login:\n   ${urlMatch[0]}`);
        }
        reject(new Error(`Login failed with code ${code}`));
      }
    });

    child.on("error", (error: Error) => {
      keypressCleanup?.();
      reject(error);
    });
  });
}

/**
 * Copy text to clipboard (cross-platform).
 * Uses spawnSync so it can be called synchronously from a keypress handler.
 */
function copyToClipboard(text: string): void {
  const input = Buffer.from(text);
  try {
    if (process.platform === "darwin") {
      spawnSync("pbcopy", [], { input, stdio: ["pipe", "ignore", "ignore"] });
    } else if (process.platform === "win32") {
      spawnSync("clip", [], { input, stdio: ["pipe", "ignore", "ignore"] });
    } else {
      // Linux: try xclip, fall back to xsel
      const r = spawnSync("xclip", ["-selection", "clipboard"], {
        input,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (r.error || r.status !== 0) {
        spawnSync("xsel", ["--clipboard", "--input"], {
          input,
          stdio: ["pipe", "ignore", "ignore"],
        });
      }
    }
  } catch {
    // Clipboard not available — silently ignore, user still has the URL on screen
  }
}

/**
 * Wait for auth to be configured after login
 */
export async function waitForAuth(): Promise<void> {
  console.log("Waiting for authentication...");

  // Restart proxy so it picks up the newly-written credentials.
  // The running proxy was started before login and has no knowledge of new creds.
  await killProxy();
  await sleep(CONFIG.PROXY_KILL_WAIT_MS);
  await startProxy(); // waits until proxy is accepting connections

  for (let i = 0; i < CONFIG.AUTH_WAIT_MAX_RETRIES; i++) {
    await sleep(CONFIG.AUTH_WAIT_RETRY_DELAY_MS);
    const auth = await checkAuthConfigured();
    // Accept any positive signal: live models, proxy auth entries, or credential files.
    // hasAuthFiles alone is sufficient here because launchLogin() already exited 0
    // and the proxy was just restarted fresh — the file is the ground truth.
    if (auth.configured || auth.hasAuthFiles) {
      console.log("Authentication configured.");
      return;
    }
  }

  throw new Error("Authentication still not configured after login.");
}
