import { createPostgresHomeworkDatabase } from './postgres-homework-db.js';

export {
  DATABASE_VERSION,
  HomeworkDatabaseError,
  assertTask,
  baselineMetaKey,
  externalId,
  normalizeTimestampForStorage,
  parseJson,
  rowToTask,
  serializeJson,
  sourceId,
  targetId,
  taskIdentity,
} from './homework-db-shared.js';

export { createPostgresHomeworkDatabase };

export async function createHomeworkDatabase(options = {}) {
  return createPostgresHomeworkDatabase(options);
}
