import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'fs';
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
      writeFileSync(this.filePath, JSON.stringify(envelope, null, 2), 'utf-8');
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
