import { openSync, readSync, closeSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { inflateSync, inflateRawSync } from "node:zlib";
import { parsePakIndex, type PakIndex, type PakDirEntry, type PakFileEntry } from "./reader.js";
import { ExportVirtualFS } from "./export-vfs.js";
import { logger } from "../utils/logger.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface VfsEntry {
  name: string;
  isDirectory: boolean;
  /** Decompressed size for files, 0 for directories */
  size: number;
}

interface FileRef {
  pakPath: string;
  entry: PakFileEntry;
  /** Original-cased virtual path as stored in the pak (for display/indexing) */
  path: string;
}

/**
 * Decompress a file payload. Real Reforger .pak files use zlib-wrapped
 * (deflate with zlib header) streams, while some synthetic/raw payloads use
 * raw deflate. Try zlib first, fall back to raw deflate.
 */
function inflatePayload(buf: Buffer): Buffer {
  try {
    return inflateSync(buf);
  } catch {
    return inflateRawSync(buf);
  }
}

// ── PakVirtualFS ─────────────────────────────────────────────────────────────

/**
 * Virtual filesystem that merges all .pak files in the game's addons/ directory
 * into a single unified file tree. Supports directory listing, file existence
 * checks, and on-demand file reading with automatic zlib decompression.
 *
 * Instantiated lazily as a singleton and cached for the session lifetime.
 */
export class PakVirtualFS {
  private static instance: PakVirtualFS | null = null;
  private static instanceGamePath: string | null = null;

  /** Flat lookup: normalized virtual path → file reference */
  private fileIndex = new Map<string, FileRef>();
  /** Merged directory tree for browsing */
  private root: PakDirEntry = { kind: "dir", name: "", children: new Map() };
  /** Export VFS for reading unpacked files directly from disk (fast, no decompression) */
  private exportVfs: ExportVirtualFS | null = null;

  /** Clear the cached VFS instance, forcing a fresh rebuild on next get(). */
  static invalidate(): void {
    PakVirtualFS.instance = null;
    PakVirtualFS.instanceGamePath = null;
    ExportVirtualFS.invalidate();
  }

  /**
   * Get or create the singleton VFS for the given game path.
   * Returns null if no .pak files are found.
   */
  static get(gamePath: string): PakVirtualFS | null {
    if (PakVirtualFS.instance && PakVirtualFS.instanceGamePath === gamePath) {
      return PakVirtualFS.instance;
    }

    const addonsPath = join(gamePath, "addons");
    if (!existsSync(addonsPath)) return null;

    let pakFiles: string[];
    try {
      // Scan addons/ directly, then one level deep (e.g. addons/data/, addons/core/)
      const topEntries = readdirSync(addonsPath, { withFileTypes: true });
      pakFiles = topEntries
        .filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".pak")
        .map((e) => join(addonsPath, e.name));

      for (const entry of topEntries) {
        if (!entry.isDirectory()) continue;
        try {
          const subEntries = readdirSync(join(addonsPath, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && extname(sub.name).toLowerCase() === ".pak") {
              pakFiles.push(join(addonsPath, entry.name, sub.name));
            }
          }
        } catch {
          // Skip unreadable subdirectories
        }
      }

      // Scan additional directories from ENFUSION_EXTRA_PAK_DIRS
      const extraDirs = process.env.ENFUSION_EXTRA_PAK_DIRS;
      if (extraDirs) {
        for (const dir of extraDirs.split(",").map((d) => d.trim()).filter(Boolean)) {
          if (!existsSync(dir)) continue;
          try {
            const extraEntries = readdirSync(dir, { withFileTypes: true });
            for (const entry of extraEntries) {
              if (entry.isFile() && extname(entry.name).toLowerCase() === ".pak") {
                pakFiles.push(join(dir, entry.name));
              } else if (entry.isDirectory()) {
                try {
                  const subEntries = readdirSync(join(dir, entry.name), { withFileTypes: true });
                  for (const sub of subEntries) {
                    if (sub.isFile() && extname(sub.name).toLowerCase() === ".pak") {
                      pakFiles.push(join(dir, entry.name, sub.name));
                    }
                  }
                } catch {
                  // Skip
                }
              }
            }
          } catch {
            // Skip unreadable extra directories
          }
        }
      }

      pakFiles.sort(); // deterministic order — first pak alphabetically wins on duplicates
    } catch {
      return null;
    }

    if (pakFiles.length === 0) return null;

    const vfs = new PakVirtualFS(pakFiles);
    PakVirtualFS.instance = vfs;
    PakVirtualFS.instanceGamePath = gamePath;
    return vfs;
  }

  /**
   * Set the export path for this VFS instance. This enables reading files directly
   * from the unpacked export directory (faster than decompressing from paks).
   */
  setExportPath(exportPath: string): void {
    this.exportVfs = ExportVirtualFS.get(exportPath);
  }

  private constructor(pakFiles: string[]) {
    const start = Date.now();
    let totalFiles = 0;

    for (const pakPath of pakFiles) {
      try {
        const index = parsePakIndex(pakPath);
        const count = this.mergeTree(this.root, index.root, index, "");
        totalFiles += count;
      } catch (e) {
        logger.warn(`Failed to parse pak file ${pakPath}: ${e}`);
        // Continue with other paks — graceful degradation
      }
    }

    const elapsed = Date.now() - start;
    logger.info(
      `PAK VFS initialized: ${pakFiles.length} pak files, ${totalFiles} entries, ` +
      `${this.fileIndex.size} files indexed in ${elapsed}ms`
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * List entries in a virtual directory.
   * Path uses forward slashes, no leading slash (e.g., "Prefabs/Weapons").
   * Empty string = root. Merges entries from pak index and export VFS.
   */
  listDir(virtualPath: string): VfsEntry[] {
    const norm = normalizePath(virtualPath);
    const entries: VfsEntry[] = [];
    const seen = new Set<string>();

    // Pak directory entries
    const dir = this.resolveDir(norm);
    if (dir) {
      for (const [name, child] of dir.children) {
        const lower = name.toLowerCase();
        seen.add(lower);
        if (child.kind === "dir") {
          entries.push({ name, isDirectory: true, size: 0 });
        } else {
          entries.push({ name, isDirectory: false, size: child.decompressedLen });
        }
      }
    }

    // Export VFS entries (merge with pak)
    if (this.exportVfs) {
      const exportEntries = this.exportVfs.listDir(norm);
      for (const ee of exportEntries) {
        if (!seen.has(ee.name.toLowerCase())) {
          entries.push({ name: ee.name, isDirectory: ee.isDirectory, size: ee.size });
        }
      }
    }

    return entries;
  }

  /** Check if a path exists (file or directory). Checks both pak index and export VFS. */
  exists(virtualPath: string): boolean {
    const norm = normalizePath(virtualPath);
    if (norm === "") return true; // root always exists
    if (this.fileIndex.has(norm)) return true;
    if (this.resolveDir(norm) !== null) return true;
    if (this.exportVfs && this.exportVfs.exists(norm)) return true;
    return false;
  }

  /**
   * Read a file's raw bytes from the pak archive.
   * If an export VFS is available and has the file, reads from disk (faster, no decompression).
   * Opens the .pak, seeks to the correct offset, reads, decompresses if needed.
   */
  readFile(virtualPath: string): Buffer {
    const norm = normalizePath(virtualPath);
    // Prefer export VFS (faster — no decompression needed)
    if (this.exportVfs && this.exportVfs.exists(norm)) {
      const text = this.exportVfs.readTextFile(norm);
      return Buffer.from(text, "utf-8");
    }

    const ref = this.fileIndex.get(norm);
    if (!ref) {
      throw new Error(`File not found in pak: ${virtualPath}`);
    }

    const { pakPath, entry } = ref;
    const readLen = entry.compressed ? entry.compressedLen : entry.decompressedLen;

    const fd = openSync(pakPath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      // entry.offset is an ABSOLUTE byte offset within the .pak file
      // (the file body begins right at the DATA payload start; do NOT add dataStart).
      const position = entry.offset;
      const bytesRead = readSync(fd, buf, 0, readLen, position);
      if (bytesRead < readLen) {
        throw new Error(
          `Truncated read from pak: expected ${readLen} bytes, got ${bytesRead}`
        );
      }

      if (entry.compressed) {
        return inflatePayload(buf);
      }
      return buf;
    } finally {
      closeSync(fd);
    }
  }

  /** Read a file as UTF-8 text. Prefers export VFS (faster, no decompression). */
  readTextFile(virtualPath: string): string {
    const norm = normalizePath(virtualPath);
    // Prefer export VFS (faster — no decompression needed)
    if (this.exportVfs && this.exportVfs.exists(norm)) {
      return this.exportVfs.readTextFile(norm);
    }
    return this.readFile(virtualPath).toString("utf-8");
  }

  /** Get decompressed file size without reading/inflating. Returns -1 if not found. Checks export VFS too. */
  fileSize(virtualPath: string): number {
    const norm = normalizePath(virtualPath);
    const ref = this.fileIndex.get(norm);
    if (ref) return ref.entry.decompressedLen;
    if (this.exportVfs) {
      const exportSize = this.exportVfs.fileSize(norm);
      if (exportSize >= 0) return exportSize;
    }
    return -1;
  }

  /** Get all file paths in the VFS (for building the asset search index). */
  allFilePaths(): string[] {
    return Array.from(this.fileIndex.values()).map((r) => r.path);
  }

  /**
   * Search files by name pattern. Supports:
   * - Exact substring: "InventoryMenu" matches any path containing it
   * - Glob-style: "*Inventory*.c" — * is a wildcard for any characters
   * - Extension filter: ".c" matches all .c files
   * - Combined: "SCR_*.c" matches all scripts starting with SCR_
   *
   * Case-insensitive. Returns up to `limit` results, sorted by relevance.
   * Searches both pak index and export VFS.
   */
  searchFiles(pattern: string, limit: number = 50): string[] {
    const results: Array<{ path: string; score: number }> = [];
    const seen = new Set<string>();
    const patLower = pattern.toLowerCase();

    // Parse glob-style pattern
    const hasGlob = pattern.includes("*");
    let regex: RegExp | null = null;
    if (hasGlob) {
      // Convert glob to regex: * → [^/]*, ? → [^/], escape the rest
      const escaped = patLower
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      regex = new RegExp(escaped, "i");
    }

    function scorePath(pathLower: string, filename: string): number {
      if (regex) {
        if (regex.test(pathLower)) {
          return regex.test(filename) ? 80 : 50;
        }
        return 0;
      }
      if (filename === patLower) return 100;
      if (filename.startsWith(patLower)) return 90;
      if (filename.includes(patLower)) return 80;
      if (pathLower.endsWith("/" + patLower) || pathLower.includes(patLower)) return 40;
      return 0;
    }

    // Search pak index
    for (const ref of this.fileIndex.values()) {
      const pathLower = ref.path.toLowerCase();
      const segments = ref.path.split("/");
      const filename = segments[segments.length - 1]?.toLowerCase() ?? "";
      const score = scorePath(pathLower, filename);
      if (score > 0) {
        seen.add(pathLower);
        results.push({ path: ref.path, score });
      }
    }

    // Search export VFS
    if (this.exportVfs) {
      for (const exportPath of this.exportVfs.allFilePaths()) {
        if (seen.has(exportPath)) continue;
        const segments = exportPath.split("/");
        const filename = segments[segments.length - 1]?.toLowerCase() ?? "";
        const score = scorePath(exportPath, filename);
        if (score > 0) {
          results.push({ path: exportPath, score });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.path);
  }

  /**
   * Search for files whose content matches a string (case-insensitive substring).
   * Only searches text files (.c, .conf, .layout, etc.). Reads file content from paks and export.
   * Returns up to `limit` matching file paths.
   */
  searchFileContent(query: string, extensions: string[], limit: number = 50): string[] {
    const results: string[] = [];
    const seen = new Set<string>();
    const queryLower = query.toLowerCase();
    const extSet = new Set(extensions.map((e) => e.toLowerCase()));

    function matchesExt(path: string): boolean {
      const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
      return extSet.has(ext);
    }

    // Search pak index
    for (const ref of this.fileIndex.values()) {
      if (results.length >= limit) break;
      if (!matchesExt(ref.path)) continue;
      if (ref.entry.decompressedLen > 512_000) continue;

      try {
        const content = this.readTextFile(ref.path);
        if (content.toLowerCase().includes(queryLower)) {
          seen.add(ref.path.toLowerCase());
          results.push(ref.path);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Search export VFS
    if (this.exportVfs) {
      for (const exportPath of this.exportVfs.allFilePaths()) {
        if (results.length >= limit) break;
        if (seen.has(exportPath)) continue;
        if (!matchesExt(exportPath)) continue;

        try {
          const size = this.exportVfs.fileSize(exportPath);
          if (size > 512_000) continue;
          const content = this.exportVfs.readTextFile(exportPath);
          if (content.toLowerCase().includes(queryLower)) {
            results.push(exportPath);
          }
        } catch {
          // Skip
        }
      }
    }

    return results;
  }

  /** Get the number of indexed files. */
  get fileCount(): number {
    return this.fileIndex.size;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Merge a parsed pak tree into the unified directory tree.
   * Returns the number of file entries added.
   * Case-insensitive: Windows/Enfusion paths are case-insensitive.
   */
  private mergeTree(
    target: PakDirEntry,
    source: PakDirEntry,
    index: PakIndex,
    pathPrefix: string
  ): number {
    let count = 0;

    for (const [name, child] of source.children) {
      const childPath = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (child.kind === "dir") {
        // Merge directories case-insensitively: find existing child ignoring case
        let targetChild = findChildDir(target, name);
        if (!targetChild) {
          targetChild = { kind: "dir", name, children: new Map() };
          target.children.set(name, targetChild);
        }
        count += this.mergeTree(targetChild, child, index, childPath);
      } else {
        // File: add to target and flat index (first pak wins) — case-insensitive via normalizePath
        const norm = normalizePath(childPath);
        if (!this.fileIndex.has(norm)) {
          // Avoid duplicate filename with different case in same directory
          if (!hasChildFile(target, name)) {
            target.children.set(name, child);
          }
          this.fileIndex.set(norm, {
            pakPath: index.pakPath,
            entry: child,
            path: childPath,
          });
          count++;
        }
      }
    }

    return count;
  }

  /** Resolve a virtual path to a directory entry, or null if not found. Case-insensitive. */
  private resolveDir(virtualPath: string): PakDirEntry | null {
    const norm = normalizePath(virtualPath);
    if (norm === "") return this.root;

    const parts = norm.split("/");
    let current: PakDirEntry = this.root;

    for (const part of parts) {
      const child = findChildDir(current, part);
      if (!child) return null;
      current = child;
    }

    return current;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Case-insensitive directory child lookup */
function findChildDir(dir: PakDirEntry, name: string): PakDirEntry | null {
  const lower = name.toLowerCase();
  for (const [, child] of dir.children) {
    if (child.kind === "dir" && child.name.toLowerCase() === lower) return child;
  }
  return null;
}

function hasChildFile(dir: PakDirEntry, name: string): boolean {
  const lower = name.toLowerCase();
  for (const [, child] of dir.children) {
    if (child.kind === "file" && child.name.toLowerCase() === lower) return true;
  }
  return false;
}

/** Normalize a virtual path: trim slashes, convert backslashes, collapse, lowercase. Enfusion/Windows is case-insensitive. */
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}
