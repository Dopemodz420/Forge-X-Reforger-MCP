import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { logger } from "../utils/logger.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ExportVfsEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface ExportFileRef {
  /** Absolute path on disk */
  diskPath: string;
  /** Virtual path (normalized, lowercase) */
  virtualPath: string;
  /** Original-cased virtual path for display */
  displayPath: string;
  /** Source directory name (e.g., "data07", "core-data01") */
  source: string;
  size: number;
}

// ── Directory name → virtual path prefix mapping ─────────────────────────────
// Export directories have names like "data07", "core-data01", "data", "data010".
// The content inside maps to virtual paths by stripping the dir name prefix.

const DIR_PREFIX_MAP: Record<string, string> = {
  "core-data01": "",    // core-data01/scripts/ → scripts/
  "data": "",           // data/AI/ → AI/
  "data01": "",         // data01/Assets/ → Assets/
  "data02": "",
  "data03": "",
  "data04": "",
  "data05": "",
  "data06": "",
  "data07": "",         // data07/scripts/ → scripts/
  "data08": "",
  "data09": "",
  "data010": "",        // data010/UI/ → UI/
};

// ── ExportVirtualFS ──────────────────────────────────────────────────────────

/**
 * Virtual filesystem backed by an unpacked export directory (e.g., from ReforgerPakTool).
 * All files are on disk as plain text — no decompression needed.
 * Maps export directory paths to Enfusion virtual paths by stripping the dataXX/ prefix.
 */
export class ExportVirtualFS {
  private static instance: ExportVirtualFS | null = null;
  private static instancePath: string | null = null;

  /** virtual path (normalized) → absolute disk path */
  private fileIndex = new Map<string, string>();
  /** virtual path (normalized) → directory listing */
  private dirIndex = new Map<string, Map<string, boolean>>();

  static invalidate(): void {
    ExportVirtualFS.instance = null;
    ExportVirtualFS.instancePath = null;
  }

  static get(exportPath: string): ExportVirtualFS | null {
    if (ExportVirtualFS.instance && ExportVirtualFS.instancePath === exportPath) {
      return ExportVirtualFS.instance;
    }

    if (!existsSync(exportPath)) return null;

    const vfs = new ExportVirtualFS(exportPath);
    ExportVirtualFS.instance = vfs;
    ExportVirtualFS.instancePath = exportPath;
    return vfs;
  }

  private constructor(exportPath: string) {
    const start = Date.now();
    let totalFiles = 0;

    // Scan each top-level directory (core-data01, data, data01..data010)
    let entries;
    try {
      entries = readdirSync(exportPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      const dirPath = join(exportPath, dirName);

      // Strip the dataXX/ or core-dataXX/ prefix to get virtual path root
      // e.g., "data07" → "", "core-data01" → ""
      // The subdirectories become the virtual path root
      // e.g., data07/scripts/Game/UI → scripts/Game/UI
      // e.g., core-data01/configs → configs
      // e.g., data010/UI → UI

      try {
        this.indexDirectory(dirPath, "", totalFiles);
      } catch {
        // Skip unreadable directories
      }
    }

    // Rebuild directory index from file index
    this.buildDirIndex();

    const elapsed = Date.now() - start;
    logger.info(
      `Export VFS initialized: ${this.fileIndex.size} files indexed from ${entries.length} export dirs in ${elapsed}ms`
    );
  }

  private indexDirectory(
    dirPath: string,
    virtualPrefix: string,
    _counter: number
  ): number {
    let count = 0;
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const virtualPath = virtualPrefix
        ? `${virtualPrefix}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        count += this.indexDirectory(fullPath, virtualPath, count);
      } else {
        // Store with original casing for display, but index with lowercase for case-insensitive lookup
        const norm = normalizeVirtualPath(virtualPath);
        if (!this.fileIndex.has(norm)) {
          this.fileIndex.set(norm, fullPath);
          count++;
        }
      }
    }

    return count;
  }

  private buildDirIndex(): void {
    for (const [normPath] of this.fileIndex) {
      const parts = normPath.split("/");
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const parent = current ? `${current}/${parts[i]}` : parts[i];
        const child = current ? `${current}/${parts[i]}/${parts[i + 1]}` : `${parts[i]}/${parts[i + 1]}`;
        if (!this.dirIndex.has(parent)) {
          this.dirIndex.set(parent, new Map());
        }
        this.dirIndex.get(parent)!.set(parts[i], true);
        current = parent;
      }
    }
  }

  /** Check if a virtual path exists (file or directory). */
  exists(virtualPath: string): boolean {
    const norm = normalizeVirtualPath(virtualPath);
    if (norm === "") return true;
    return this.fileIndex.has(norm) || this.dirIndex.has(norm);
  }

  /** List entries in a virtual directory. */
  listDir(virtualPath: string): ExportVfsEntry[] {
    const norm = normalizeVirtualPath(virtualPath);
    const dir = this.dirIndex.get(norm);
    if (!dir) return [];

    const entries: ExportVfsEntry[] = [];
    for (const [name] of dir) {
      // Check if it's a file or directory
      const childPath = norm ? `${norm}/${name}` : name;
      if (this.fileIndex.has(childPath)) {
        const diskPath = this.fileIndex.get(childPath)!;
        try {
          const stats = statSync(diskPath);
          entries.push({ name, isDirectory: false, size: stats.size });
        } catch {
          entries.push({ name, isDirectory: false, size: 0 });
        }
      } else {
        entries.push({ name, isDirectory: true, size: 0 });
      }
    }
    return entries;
  }

  /** Read a file as UTF-8 text from the export directory. */
  readTextFile(virtualPath: string): string {
    const norm = normalizeVirtualPath(virtualPath);
    const diskPath = this.fileIndex.get(norm);
    if (!diskPath) {
      throw new Error(`File not found in export: ${virtualPath}`);
    }
    return readFileSync(diskPath, "utf-8");
  }

  /** Get file size. Returns -1 if not found. */
  fileSize(virtualPath: string): number {
    const norm = normalizeVirtualPath(virtualPath);
    const diskPath = this.fileIndex.get(norm);
    if (!diskPath) return -1;
    try {
      return statSync(diskPath).size;
    } catch {
      return -1;
    }
  }

  /** Get all file paths (virtual paths). */
  allFilePaths(): string[] {
    return Array.from(this.fileIndex.keys());
  }

  /**
   * Search files by name pattern. Supports glob and substring matching.
   * Case-insensitive. Returns up to `limit` results sorted by relevance.
   */
  searchFiles(pattern: string, limit: number = 50): string[] {
    const results: Array<{ path: string; score: number }> = [];
    const patLower = pattern.toLowerCase();

    const hasGlob = pattern.includes("*");
    let regex: RegExp | null = null;
    if (hasGlob) {
      const escaped = patLower
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      regex = new RegExp(escaped, "i");
    }

    for (const virtualPath of this.fileIndex.keys()) {
      const pathLower = virtualPath.toLowerCase();
      const segments = virtualPath.split("/");
      const filename = segments[segments.length - 1]?.toLowerCase() ?? "";

      let score = 0;

      if (regex) {
        if (regex.test(pathLower)) {
          score = regex.test(filename) ? 80 : 50;
        }
      } else {
        if (filename === patLower) score = 100;
        else if (filename.startsWith(patLower)) score = 90;
        else if (filename.includes(patLower)) score = 80;
        else if (pathLower.includes(patLower)) score = 40;
      }

      if (score > 0) {
        results.push({ path: virtualPath, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.path);
  }

  /** Search for files whose content matches a query. Only text files. */
  searchFileContent(query: string, extensions: string[], limit: number = 50): string[] {
    const results: string[] = [];
    const queryLower = query.toLowerCase();
    const extSet = new Set(extensions.map((e) => e.toLowerCase()));

    for (const [virtualPath, diskPath] of this.fileIndex) {
      if (results.length >= limit) break;

      const ext = virtualPath.substring(virtualPath.lastIndexOf(".")).toLowerCase();
      if (!extSet.has(ext)) continue;

      try {
        const stats = statSync(diskPath);
        if (stats.size > 512_000) continue;
        const content = readFileSync(diskPath, "utf-8");
        if (content.toLowerCase().includes(queryLower)) {
          results.push(virtualPath);
        }
      } catch {
        // Skip
      }
    }

    return results;
  }

  get fileCount(): number {
    return this.fileIndex.size;
  }

  /** Build dir index from file index */
  private buildDirIndexFromFiles(): void {
    this.dirIndex.clear();
    for (const [normPath] of this.fileIndex) {
      const parts = normPath.split("/");
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const key = current ? `${current}/${parts[i]}` : parts[i];
        if (!this.dirIndex.has(key)) {
          this.dirIndex.set(key, new Map());
        }
        this.dirIndex.get(key)!.set(parts[i], true);
        current = key;
      }
    }
  }
}

function normalizeVirtualPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}
