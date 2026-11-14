/**
 * In-memory copy of the server workspace revision this page last synchronized with.
 * Never persisted: a reloaded page always re-reads the revision from the server.
 */
let currentRevision: number | null = null;

export function setKnownWorkspaceRevision(revision: unknown): void {
  if (typeof revision === 'number' && Number.isFinite(revision)) currentRevision = revision;
}

export function withBaseRevision<T extends object>(payload: T): T & { baseRevision?: number } {
  return currentRevision === null ? payload : { ...payload, baseRevision: currentRevision };
}
