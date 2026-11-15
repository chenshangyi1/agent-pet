const attentionStatuses = new Set(['waiting', 'blocked', 'ready']);

/** Track attention changes per conversation, independently of display priority. */
export function createActivityNoticeTracker() {
  const previous = new Map();
  return rows => {
    const current = new Set();
    const notices = [];
    for (const row of rows) {
      current.add(row.sessionId);
      const key = `${row.status}:${row.lastSeq ?? -1}:${row.updatedAt ?? ''}`;
      const old = previous.get(row.sessionId);
      if (key !== old && attentionStatuses.has(row.status)) notices.push(row);
      previous.set(row.sessionId, key);
    }
    for (const id of previous.keys()) if (!current.has(id)) previous.delete(id);
    return notices;
  };
}
