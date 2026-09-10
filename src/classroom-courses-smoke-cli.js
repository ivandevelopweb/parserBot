import 'dotenv/config';

import { createClassroomWebClient } from './classroom-web.js';

function tableValue(value) {
  return String(value ?? '—')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('|', '/');
}

function newestAssignment(assignments) {
  return assignments
    .filter((assignment) => assignment.updatedAt)
    .sort((first, second) => (
      Date.parse(second.updatedAt) - Date.parse(first.updatedAt)
    ))[0]
    ?? assignments[0]
    ?? null;
}

async function main() {
  const client = createClassroomWebClient();
  const courses = await client.getCourses();
  const rows = [];
  let failed = false;

  for (const course of courses) {
    try {
      const result = await client.getCourseWorkForCourse(course.courseId, {
        includePagination: true,
      });
      const newest = newestAssignment(result.assignments);
      rows.push({
        name: course.name,
        assignments: result.assignments.length,
        pages: result.pagesFetched,
        newest: newest?.title || newest?.assignmentId || '—',
      });
    } catch {
      // Keep the table shape stable while still attempting every discovered
      // course. A non-zero exit tells automation that at least one RPC failed.
      failed = true;
      rows.push({
        name: course.name,
        assignments: 'ERROR',
        pages: 'ERROR',
        newest: 'ERROR',
      });
    }
  }

  console.log(`[Classroom] courses discovered: ${courses.length}`);
  console.log('course name | assignments fetched | pages fetched | newest assignment');
  for (const row of rows) {
    console.log(`${tableValue(row.name)} | ${row.assignments} | ${row.pages} | ${tableValue(row.newest)}`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
