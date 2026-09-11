import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { newDb } from 'pg-mem';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [key, inlineValue] = argument.slice(2).split('=', 2);
    result[key] = inlineValue ?? argv[index + 1] ?? true;
    if (inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      index += 1;
    }
  }
  return result;
}

async function importSourceModule(sourceRoot, relativePath) {
  return import(pathToFileURL(resolve(sourceRoot, relativePath)).href);
}

function commandName(sql) {
  return String(sql).trim().match(/^[A-Za-z]+/u)?.[0]?.toUpperCase() ?? 'OTHER';
}

function createQueryStats() {
  return { calls: 0, returnedRows: 0, changedRows: 0, approxResultBytes: 0, commands: {} };
}

function instrumentPool(pool, stats) {
  async function query(executor, args) {
    const command = commandName(args[0]);
    stats.calls += 1;
    stats.commands[command] = (stats.commands[command] ?? 0) + 1;
    const result = await executor.query(...args);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    stats.returnedRows += rows.length;
    stats.approxResultBytes += Buffer.byteLength(JSON.stringify(rows), 'utf8');
    if (['INSERT', 'UPDATE', 'DELETE'].includes(command)) {
      stats.changedRows += Number(result?.rowCount ?? 0);
    }
    return result;
  }

  return {
    query: (...args) => query(pool, args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (...args) => query(client, args),
        release: (...args) => client.release(...args),
      };
    },
    end: (...args) => pool.end?.(...args),
  };
}

function resetStats(stats) {
  stats.calls = 0;
  stats.returnedRows = 0;
  stats.changedRows = 0;
  stats.approxResultBytes = 0;
  stats.commands = {};
}

function snapshotStats(stats) {
  return {
    sqlCalls: stats.calls,
    returnedRows: stats.returnedRows,
    changedRows: stats.changedRows,
    approxResultBytes: stats.approxResultBytes,
    commands: { ...stats.commands },
  };
}

function cloneTasks(tasks) {
  return tasks.map((task) => structuredClone(task));
}

function createEschoolTasks(count) {
  const longDescription = 'Long synthetic homework <> & 😀 '.repeat(80);
  return Array.from({ length: count }, (_, index) => ({
    targetAppointmentId: 700000 + index,
    homeworkId: 800000 + index,
    subject: index % 2 === 0 ? 'Алгебра' : 'Історія',
    topic: `Тема ${index % 9}`,
    description: index === 0 ? longDescription : `Виконати синтетичну вправу ${index}`,
    assignedDate: '2026-09-09',
    targetDate: '2026-09-11',
    lessonNumber: (index % 7) + 1,
    startTime: '11:25',
    filesCount: index % 4,
  }));
}

function createClassroomTasks(count, toSyncTask) {
  const longDescription = 'Long synthetic Classroom description <> & 😀 '.repeat(80);
  return Array.from({ length: count }, (_, index) => toSyncTask({
    source: 'classroom',
    externalId: `course-${index % 8}:work-${index}`,
    courseId: `course-${index % 8}`,
    courseWorkId: `work-${index}`,
    subject: `Class ${index % 8}`,
    title: `Synthetic assignment ${index}`,
    description: index === 0 ? longDescription : `Complete synthetic task ${index}`,
    targetDate: '2026-09-11',
    targetTime: '11:25',
    url: `https://classroom.google.com/c/course-${index % 8}/a/work-${index}/details`,
    updatedAt: '2026-09-09T10:00:00.000Z',
    publishedAt: '2026-09-09T10:00:00.000Z',
    filesCount: index % 4,
  }));
}

function classroomResult(tasks, statusById = new Map()) {
  const statusUpdates = tasks.map((task) => ({
    task: { ...task, classroomStatus: statusById.get(task.externalId) ?? 'pending' },
    status: statusById.get(task.externalId) ?? 'pending',
  }));
  return {
    homeworkTasks: tasks
      .filter((task) => (statusById.get(task.externalId) ?? 'pending') === 'pending')
      .map((task) => ({ ...task, classroomStatus: 'pending' })),
    statusUpdates,
    currentExternalIds: tasks.map((task) => task.externalId),
    snapshotComplete: true,
    statusReconciliationComplete: true,
    statusSyncEnabled: true,
  };
}

function makeMetricRow(scenario, stats, result, durationMs) {
  const metrics = result?.metrics ?? {};
  return {
    scenario,
    ...snapshotStats(stats),
    observed: metrics.observed ?? null,
    inserted: metrics.inserted ?? null,
    changed: metrics.changed ?? null,
    unchanged: metrics.unchanged ?? null,
    markedNotCurrent: metrics.notCurrent ?? null,
    statusTransitions: metrics.statusTransitions ?? null,
    notificationsQueued: metrics.notificationsQueued ?? null,
    notificationsSent: metrics.notificationsSent ?? null,
    durationMs: Number(durationMs.toFixed(3)),
  };
}

async function benchmarkProvider({ source, tasks, makeResult, syncProviderHomeworks, createDatabase }) {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const rawPool = new Pool();
  const stats = createQueryStats();
  const database = await createDatabase({
    connectionString: 'postgresql://benchmark/benchmark',
    pool: instrumentPool(rawPool, stats),
  });
  const rows = [];

  async function run(scenario, providerResult, now) {
    resetStats(stats);
    const started = performance.now();
    const result = await syncProviderHomeworks({
      source,
      fetchTasksFn: async () => providerResult,
      database,
      legacyStateStore: null,
      sendMessageFn: async () => {},
      logger: () => {},
      now: new Date(now),
    });
    rows.push(makeMetricRow(scenario, stats, result, performance.now() - started));
  }

  const base = cloneTasks(tasks);
  await run('baseline', makeResult(base), '2026-09-11T10:00:00.000Z');
  await run('unchanged', makeResult(base), '2026-09-11T10:10:00.000Z');

  const changed = cloneTasks(base);
  if (source === 'eschool') {
    changed[0].description += ' — changed';
  } else {
    changed[0] = {
      ...changed[0],
      snapshot: { ...changed[0].snapshot, description: `${changed[0].snapshot.description} — changed` },
    };
  }
  await run('single-change', makeResult(changed), '2026-09-11T10:20:00.000Z');
  await run('missing-one', makeResult(base.slice(0, -1)), '2026-09-11T10:30:00.000Z');

  if (source === 'classroom') {
    const statuses = new Map([[base[1].externalId, 'completed']]);
    await run('status-change', makeResult(base, statuses), '2026-09-11T10:40:00.000Z');
  } else {
    rows.push({ scenario: 'status-change', notApplicable: true });
  }

  await database.close();
  return rows;
}

function combinedRows(providers) {
  const byScenario = new Map();
  for (const provider of providers) {
    for (const row of provider.rows) {
      if (row.notApplicable) continue;
      const combined = byScenario.get(row.scenario) ?? {
        scenario: row.scenario, sqlCalls: 0, returnedRows: 0, changedRows: 0, approxResultBytes: 0,
      };
      for (const field of ['sqlCalls', 'returnedRows', 'changedRows', 'approxResultBytes']) {
        combined[field] += row[field];
      }
      byScenario.set(row.scenario, combined);
    }
  }
  return [...byScenario.values()];
}

function markdownReport(report) {
  const lines = [
    `# Neon optimization benchmark: ${report.label}`,
    '',
    `Generated with Node ${report.nodeVersion} on artificial pg-mem data.`,
    '',
    'Result bytes are UTF-8 sizes of JSON-serialized returned rows. They are an approximation, not PostgreSQL wire traffic and not a Neon counter.',
    '',
    '| Provider | Scenario | SQL calls | Returned rows | Changed rows | Approx result bytes |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const provider of report.providers) {
    for (const row of provider.rows) {
      lines.push(`| ${provider.source} | ${row.scenario} | ${row.sqlCalls ?? '—'} | ${row.returnedRows ?? '—'} | ${row.changedRows ?? '—'} | ${row.approxResultBytes ?? '—'} |`);
    }
  }
  const total = report.combined.reduce((acc, row) => ({
    sqlCalls: acc.sqlCalls + row.sqlCalls,
    returnedRows: acc.returnedRows + row.returnedRows,
    changedRows: acc.changedRows + row.changedRows,
    approxResultBytes: acc.approxResultBytes + row.approxResultBytes,
  }), { sqlCalls: 0, returnedRows: 0, changedRows: 0, approxResultBytes: 0 });
  lines.push(`| combined | all applicable scenarios | ${total.sqlCalls} | ${total.returnedRows} | ${total.changedRows} | ${total.approxResultBytes} |`);
  if (report.comparison) {
    lines.push('', '## Comparison to the saved before run', '');
    lines.push('| Provider | Scenario | SQL calls before → after | Returned rows before → after | Changed rows before → after | Approx bytes before → after |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
    const format = (value) => value
      ? `${value.before} → ${value.after} (${value.delta >= 0 ? '+' : ''}${value.delta})`
      : '—';
    for (const provider of report.comparison.providers) {
      for (const row of provider.rows) {
        lines.push(`| ${provider.source} | ${row.scenario} | ${format(row.sqlCalls)} | ${format(row.returnedRows)} | ${format(row.changedRows)} | ${format(row.approxResultBytes)} |`);
      }
    }
    for (const row of report.comparison.combined) {
      lines.push(`| combined | ${row.scenario} | ${format(row.sqlCalls)} | ${format(row.returnedRows)} | ${format(row.changedRows)} | ${format(row.approxResultBytes)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function numericDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return { before, after, delta: after - before, ratio: before === 0 ? null : after / before };
}

function compareReports(before, after) {
  const result = { label: `${before.label} -> ${after.label}`, providers: [], combined: [] };
  for (const afterProvider of after.providers) {
    const beforeProvider = before.providers.find(({ source }) => source === afterProvider.source);
    result.providers.push({
      source: afterProvider.source,
      rows: afterProvider.rows.map((afterRow) => {
        const beforeRow = beforeProvider?.rows.find(({ scenario }) => scenario === afterRow.scenario);
        return {
          scenario: afterRow.scenario,
          sqlCalls: numericDelta(beforeRow?.sqlCalls, afterRow.sqlCalls),
          returnedRows: numericDelta(beforeRow?.returnedRows, afterRow.returnedRows),
          changedRows: numericDelta(beforeRow?.changedRows, afterRow.changedRows),
          approxResultBytes: numericDelta(beforeRow?.approxResultBytes, afterRow.approxResultBytes),
        };
      }),
    });
  }
  result.combined = after.combined.map((afterRow) => {
    const beforeRow = before.combined.find(({ scenario }) => scenario === afterRow.scenario);
    return {
      scenario: afterRow.scenario,
      sqlCalls: numericDelta(beforeRow?.sqlCalls, afterRow.sqlCalls),
      returnedRows: numericDelta(beforeRow?.returnedRows, afterRow.returnedRows),
      changedRows: numericDelta(beforeRow?.changedRows, afterRow.changedRows),
      approxResultBytes: numericDelta(beforeRow?.approxResultBytes, afterRow.approxResultBytes),
    };
  });
  return result;
}

const args = parseArguments(process.argv.slice(2));
const sourceRoot = resolve(String(args['source-root'] ?? repositoryRoot));
const label = String(args.label ?? 'run');
const [{ syncProviderHomeworks }, { createPostgresHomeworkDatabase }, { toSyncTask }] = await Promise.all([
  importSourceModule(sourceRoot, 'src/bot-sync.js'),
  importSourceModule(sourceRoot, 'src/postgres-homework-db.js'),
  importSourceModule(sourceRoot, 'src/sync.js'),
]);

const eschoolTasks = createEschoolTasks(120);
const classroomTasks = createClassroomTasks(120, toSyncTask);
const report = {
  label,
  nodeVersion: process.version,
  sourceRoot,
  data: {
    eschoolTasks: eschoolTasks.length,
    classroomTasks: classroomTasks.length,
    longestDescriptionBytes: Math.max(
      ...eschoolTasks.map((task) => Buffer.byteLength(task.description, 'utf8')),
      ...classroomTasks.map((task) => Buffer.byteLength(task.snapshot.description, 'utf8')),
    ),
  },
  providers: [],
};

report.providers.push({
  source: 'eschool',
  rows: await benchmarkProvider({
    source: 'eschool',
    tasks: eschoolTasks,
    makeResult: (tasks) => ({ homeworkTasks: tasks }),
    syncProviderHomeworks,
    createDatabase: createPostgresHomeworkDatabase,
  }),
});
report.providers.push({
  source: 'classroom',
  rows: await benchmarkProvider({
    source: 'classroom',
    tasks: classroomTasks,
    makeResult: classroomResult,
    syncProviderHomeworks,
    createDatabase: createPostgresHomeworkDatabase,
  }),
});
report.combined = combinedRows(report.providers);

if (args.before) {
  const before = JSON.parse(await readFile(resolve(String(args.before)), 'utf8'));
  report.comparison = compareReports(before, report);
}

if (args.output) {
  const outputPath = resolve(String(args.output));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(outputPath.replace(/\.json$/iu, '.md'), markdownReport(report), 'utf8');
}

console.log(JSON.stringify(report, null, 2));
