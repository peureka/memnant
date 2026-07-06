/**
 * Colony database — machine-local cross-project knowledge store.
 *
 * Lives at ~/.memnant/colony.db. Stores framework fixes, rejected
 * approaches, and preference patterns shared across all projects.
 */

import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createDatabase, openDatabase } from '../ledger/database.js';

export function getColonyDbPath(): string {
  return join(homedir(), '.memnant', 'colony.db');
}

export function openColonyDb(dbPath?: string): any {
  const path = dbPath ?? getColonyDbPath();
  const dir = path.substring(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  let db;
  if (existsSync(path)) {
    db = openDatabase(path);
  } else {
    db = createDatabase(path);
  }

  // Ensure the colony project row exists
  const existing = db.all("SELECT id FROM project WHERE id = 'colony'");
  if (existing.length === 0) {
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['colony', 'Colony', '~/.memnant', new Date().toISOString()]
    );
  }

  return db;
}
