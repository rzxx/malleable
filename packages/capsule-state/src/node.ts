import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CapsuleStateSubject = {
  readonly capsulePath: string;
};

export async function openCapsuleStateDatabase(
  capsule: CapsuleStateSubject
): Promise<DatabaseSync> {
  const dataPath = path.join(capsule.capsulePath, "data");
  await mkdir(dataPath, { recursive: true });

  const database = new DatabaseSync(path.join(dataPath, "state.sqlite"), {
    timeout: 5000
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (store, id)
    );

    CREATE TABLE IF NOT EXISTS values_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
  `);

  return database;
}
