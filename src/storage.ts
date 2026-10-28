import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
  copyFileSync,
} from 'fs';
import { copyFile, rename, rm, writeFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { logError } from './log.js';

const DEFAULT_BACKUP_COUNT = 3;

export interface VersionedEnvelope {
  _version: number;
  _savedAt: number;
}

export class VersionedStore<T extends object> {
  private filePath: string;
  private backupDir: string;
  private currentVersion: number;
  private backupCount: number;

  constructor(filePath: string, opts?: { currentVersion?: number; backupCount?: number }) {
    this.filePath = filePath;
    this.backupDir = join(dirname(filePath), '.backups');
    this.currentVersion = opts?.currentVersion ?? 1;
    this.backupCount = opts?.backupCount ?? DEFAULT_BACKUP_COUNT;
  }

  read(): (T & VersionedEnvelope) | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data !== 'object' || data === null) return null;
      return data as T & VersionedEnvelope;
    } catch (err) {
      logError('Storage read failed, attempting backup recovery:', this.filePath, err);
      return this.recoverFromBackup();
    }
  }

  write(data: T): boolean {
    this.ensureDirs();
    const envelope = {
      ...data,
      _version: this.currentVersion,
      _savedAt: Date.now(),
    } as T & VersionedEnvelope;
    try {
      this.rotateBackups();
      // Atomic write: serialize to a temp file, then rename over the target
      // so a crash mid-write can't leave a truncated JSON file.
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
      return true;
    } catch (err) {
      logError('Storage write failed:', this.filePath, err);
      return false;
    }
  }

  /**
   * Async twin of {@link write}: same atomic temp-file + rename and the same
   * backup rotation, but the disk I/O runs on the fs threadpool instead of
   * blocking the caller's event loop. Used by the TUI autosave so a multi-MB
   * session write doesn't freeze the terminal. (JSON.stringify still runs on
   * the caller — it's CPU, not I/O.)
   */
  async writeAsync(data: T): Promise<boolean> {
    this.ensureDirs();
    const envelope = {
      ...data,
      _version: this.currentVersion,
      _savedAt: Date.now(),
    } as T & VersionedEnvelope;
    try {
      await this.rotateBackupsAsync();
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
      await rename(tmpPath, this.filePath);
      return true;
    } catch (err) {
      logError('Storage write failed:', this.filePath, err);
      return false;
    }
  }

  readWithMigration(
    migrate: (raw: T & VersionedEnvelope, version: number) => T
  ): (T & VersionedEnvelope) | null {
    const data = this.read();
    if (!data) return null;

    if (data._version < this.currentVersion) {
      const migrated = migrate(data, data._version);
      this.write(migrated);
      return this.read();
    }

    return data;
  }

  listBackups(): string[] {
    try {
      if (!existsSync(this.backupDir)) return [];
      return readdirSync(this.backupDir)
        .filter((f) => f.startsWith(basename(this.filePath)))
        .sort()
        .map((f) => join(this.backupDir, f));
    } catch {
      return [];
    }
  }

  recoverFromBackup(): (T & VersionedEnvelope) | null {
    const backups = this.listBackups();
    for (const backup of backups.reverse()) {
      try {
        const raw = readFileSync(backup, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data === 'object' && data !== null) {
          logError('Storage recovered from backup:', backup);
          copyFileSync(backup, this.filePath);
          return data as T & VersionedEnvelope;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private ensureDirs(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.backupDir)) mkdirSync(this.backupDir, { recursive: true });
  }

  private rotateBackups(): void {
    const ts = Date.now();
    const base = basename(this.filePath);
    const backup = join(this.backupDir, `${base}.${ts}.bak`);

    if (existsSync(this.filePath)) {
      try {
        copyFileSync(this.filePath, backup);
      } catch {
        /* best effort */
      }
    }

    const allBackups = this.listBackups();
    while (allBackups.length > this.backupCount) {
      const oldest = allBackups.shift();
      if (oldest) {
        try {
          rmSync(oldest);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Async twin of {@link rotateBackups}; the dir listing stays sync (≤ a few entries). */
  private async rotateBackupsAsync(): Promise<void> {
    const ts = Date.now();
    const base = basename(this.filePath);
    const backup = join(this.backupDir, `${base}.${ts}.bak`);

    if (existsSync(this.filePath)) {
      try {
        await copyFile(this.filePath, backup);
      } catch {
        /* best effort */
      }
    }

    const allBackups = this.listBackups();
    while (allBackups.length > this.backupCount) {
      const oldest = allBackups.shift();
      if (oldest) {
        try {
          await rm(oldest);
        } catch {
          /* best effort */
        }
      }
    }
  }
}

export function migrateSessionV0toV1(
  raw: Record<string, unknown>,
  _version: number
): Record<string, unknown> {
  return {
    ...raw,
    _version: 1,
    _savedAt: Date.now(),
  };
}
