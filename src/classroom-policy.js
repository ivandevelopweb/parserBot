export const CLASSROOM_IMPORT_CUTOFF = '2026-09-01T00:00:00+03:00';

export function isClassroomPublicationEligible(value, { cutoff = CLASSROOM_IMPORT_CUTOFF } = {}) {
  const publication = value?.publishedAt;
  if (publication === null || publication === undefined || publication === '') {
    return false;
  }
  const timestamp = new Date(publication).getTime();
  const boundary = new Date(cutoff).getTime();
  return Number.isFinite(timestamp) && Number.isFinite(boundary) && timestamp >= boundary;
}

export function isTaskInAccountingPeriod(task) {
  const snapshot = task?.snapshot ?? task;
  return (task?.source ?? snapshot?.source) !== 'classroom'
    || isClassroomPublicationEligible(snapshot);
}
