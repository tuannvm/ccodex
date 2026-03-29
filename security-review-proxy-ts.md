# Security Review: src/proxy.ts

**Date:** 2026-03-29
**Reviewer:** Claude Opus 4.6 (High Reasoning)
**File:** src/proxy.ts (1245 lines)
**Context:** CLIProxyAPI installation and proxy management

---

## Executive Summary

The code implements secure binary installation and proxy management with strong security measures, but has **4 critical security vulnerabilities** that require immediate attention before production use. The code demonstrates good security awareness (checksum verification, archive validation, confinement checks) but has several implementation flaws.

**Overall Risk Level:** HIGH
**Recommendation:** Address P1 issues before production deployment

---

## P1: Critical Security Issues

### 1. Binary Validation is Fundamentally Flawed
**Lines:** 876-918

**Issue:** Binary validation only checks if the binary runs, not if it's the correct binary.
```typescript
if (testResult.code === 0 || testResult.code === 2) {
  debugLog("Binary validated (executable but may not support --version flag)");
  success = true;
}
```

**Impact:** An attacker could replace the binary with ANY executable that exits with code 2. No signature verification, no hash checking against known-good values, no binary metadata validation.

**Recommendation:**
- Verify the binary output contains expected version info
- Implement code signing verification
- Compare binary hash against expected checksums post-extraction
- Consider using a trusted binary signature verification mechanism

---

### 2. TOCTOU Vulnerability in Symlink Check
**Lines:** 488-499

**Issue:** Time-of-check/time-of-use (TOCTOU) vulnerability between symlink check and realpath resolution.
```typescript
const lst = await fs.lstat(full);
if (lst.isSymbolicLink()) {
  throw new Error(`Symlink not allowed in extracted archive: ${full}`);
}
// ... later ...
const rp = await fs.realpath(full);
```

**Impact:** Between the `lstat()` check and `realpath()` call, an attacker could replace the symlink with a malicious file, bypassing the symlink check.

**Recommendation:**
- Use `realpath()` first and check the result stays within bounds
- Skip the separate symlink check entirely
- Or use `fstatat()` with AT_SYMLINK_NOFOLLOW flag for atomic check

---

### 3. Archive Downloaded to Install Directory (Pre-creation Attack)
**Lines:** 616

**Issue:** Archive is downloaded directly to `~/.local/bin`, which may be world-writable.
```typescript
const archivePath = join(installDir, `cli-proxy-api-${randomSuffix}.${archiveExt}`);
```

**Impact:** If `~/.local/bin` is world-writable (common in multi-user setups), an attacker could pre-create the archive file before download, leading to race condition attacks or file content manipulation.

**Recommendation:**
- Download to system temp directory (`/tmp` or `os.tmpdir()`) with secure permissions
- Use `fs.open()` with `O_CREAT | O_EXCL` flags for atomic file creation
- Verify file ownership and permissions after download
- Set restrictive umask during download (e.g., `0o077`)

---

### 4. No Binary Integrity Verification Post-Installation
**Lines:** 931-937

**Issue:** After copying the binary to final location, there's no verification that it's still the same binary.
```typescript
await fs.copyFile(extractedBinaryPath, binaryPath);
// No verification that binaryPath still matches expected hash!
installedProxyPath = binaryPath;
```

**Impact:** If another process modifies `binaryPath` between copy and execution, you'll run untrusted code.

**Recommendation:**
- Compute hash of `binaryPath` after copy and verify against `actualHash`
- Use atomic rename operation instead of copy (write to temp file, then rename)
- Verify file permissions and ownership after copy

---

## P2: Design & Logic Issues

### 5. Unbounded Directory Traversal in Size Check
**Lines:** 447-460

**Issue:** Recursive `getDirSize()` has no depth limit, could cause stack overflow.
```typescript
async function getDirSize(dir: string, fs: typeof import("fs/promises")): Promise<number> {
  // ...
  if (ent.isDirectory()) {
    size += await getDirSize(full, fs);  // No depth limit!
  }
}
```

**Impact:** Deep directory structures could cause stack overflow or extreme processing time (DoS).

**Recommendation:**
- Add max depth limit (e.g., 20 levels)
- Add iteration counter with MAX_FILES limit
- Use iterative approach instead of recursion

---

### 6. Unbounded Recursive Processing in Confinement Check
**Lines:** 476-506

**Issue:** `assertRealpathConfinement()` has no limit on iterations.
```typescript
async function assertRealpathConfinement(rootDir: string): Promise<void> {
  const stack = [rootDir];
  while (stack.length > 0) {  // No limit on iterations!
    // ...
  }
}
```

**Impact:** Archives with millions of files could cause infinite loops or DoS.

**Recommendation:**
- Add iteration counter with MAX_FILES limit (e.g., 10000 files)
- Throw error if limit exceeded

---

### 7. Weak Checksum Parsing (Collisions Possible)
**Lines:** 214-234

**Issue:** If checksum file has multiple entries with same basename, returns first match.
```typescript
const normalizedBase = normalizedName.replace(/\\/g, "/").replace(/^.*\//, "");
if (normalizedBase === fileName) {
  return hash.toLowerCase();  // First match wins!
}
```

**Impact:** Attackers could craft malicious checksum files with duplicate basenames to cause hash collisions.

**Recommendation:**
- Track all matches and error on duplicates
- Prefer exact full path match over basename match
- Document expected checksum file format

---

### 8. Error Message Leaks Paths
**Multiple locations**

**Issue:** Error messages expose full filesystem paths.
```typescript
throw new Error(`Extracted path escapes target directory: ${full}`);
```

**Impact:** In web contexts or error logging services, this leaks directory structure.

**Recommendation:**
- Sanitize paths in error messages (e.g., show only basename)
- Use path truncation for sensitive directories
- Consider logging full paths to secure log file only

---

### 9. Cleanup Happens Twice on Error
**Lines:** 804-816, 999-1016

**Issue:** Double cleanup is confusing and could mask errors.
```typescript
try {
  // ... extraction logic ...
} catch (extractError) {
  await fs.unlink(archivePath).catch(() => {});  // Cleanup #1
  // ...
}
// ... later ...
} catch (error) {
  await fs.unlink(archivePath).catch(...);  // Cleanup #2 - duplicate!
}
```

**Impact:** Makes debugging harder, could mask actual cleanup failures.

**Recommendation:**
- Use a single finally block for cleanup
- Or rethrow without catching in inner try-catch

---

### 10. Platform Inconsistency: Windows
**Lines:** 525-531, 607-613, 848-850

**Issue:** Throws early for Windows, but has Windows-specific code throughout (dead code).

**Impact:** Code is confusing and maintenance burden.

**Recommendation:**
- Either remove all Windows code or actually support Windows
- Document Windows support status clearly

---

## P3: Minor Issues

### 11. Fragile Tar Parsing
**Lines:** 301-370

Parsing tar verbose output with whitespace splitting is fragile. Edge cases with spaces in filenames, special characters, or different tar versions could break parsing.

**Recommendation:** Consider using a proper tar library or document tar version requirements.

---

### 12. File Descriptor Leak on Spawn Error
**Lines:** 1040-1158

The error handling for spawn errors is complex and fd cleanup might not happen in all error paths.

**Recommendation:** Ensure file descriptor cleanup in all error paths using finally blocks.

---

### 13. Lock File Staleness Not Addressed
**Lines:** 538

If process crashes or is killed, lock file remains. No timeout or stale lock detection visible.

**Recommendation:** Implement lock file timeout or PID-based stale lock detection.

---

### 14. Command Validation Inconsistency
`requireTrustedCommand` (from utils) vs `requireTrustedProxyCommand` have different trust assumptions.

**Recommendation:** Document trust model for each command validation function or unify the approach.

---

## Positive Security Features

The code demonstrates several good security practices:

1. **Checksum verification** (lines 703-778) - prevents tampered downloads
2. **Archive validation** (lines 466-469) - pre-flight validation before extraction
3. **Resource limits** (lines 292-294) - prevents tar/zip bombs
4. **Path traversal protection** (lines 274-289, 420-422) - prevents zip slip attacks
5. **Symlink/hardlink rejection** (lines 424-432) - prevents link-based escapes
6. **Realpath confinement** (lines 476-506) - post-extraction validation
7. **Executable permission validation** (lines 866-874) - ensures proper permissions
8. **Binary validation** (lines 876-918) - attempts to verify binary works
9. **Install lock** (line 538) - prevents concurrent installations
10. **Restrictive log file permissions** (lines 1046-1052) - prevents log leaking

---

## Recommendations

### Immediate (Before Production)
1. Fix binary validation to verify actual binary identity
2. Fix TOCTOU vulnerability in symlink check
3. Download archives to temp directory with secure permissions
4. Verify binary hash after installation

### Short Term
1. Add depth and iteration limits to recursive operations
2. Improve checksum parsing to handle duplicates
3. Sanitize error messages to avoid path leakage
4. Consolidate cleanup logic

### Long Term
1. Consider using a proper tar library instead of parsing verbose output
2. Implement proper code signing verification
3. Add comprehensive integration tests for security scenarios
4. Document security model and threat assumptions

---

**Reviewed by:** Claude Opus 4.6
**Review Method:** Static analysis with security focus
**Strictness:** High
