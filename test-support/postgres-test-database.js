import { newDb } from 'pg-mem';

import { createPostgresHomeworkDatabase } from '../src/postgres-homework-db.js';

export async function createTestDatabase() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  return { database, memory };
}
