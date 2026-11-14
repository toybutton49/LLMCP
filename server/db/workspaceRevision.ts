// Monotonic token for workspace content. Clients echo it back on sync so a stale tab cannot overwrite newer data.
let workspaceRevision = Date.now();

export function getWorkspaceRevision(): number {
  return workspaceRevision;
}

export function bumpWorkspaceRevision(): { previous: number; current: number } {
  const previous = workspaceRevision;
  workspaceRevision = Math.max(previous + 1, Date.now());
  return { previous, current: workspaceRevision };
}
