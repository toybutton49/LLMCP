export interface RecordSummary {
  title: string;
  badge: string;
  snippet: string;
}

export function getRecordSummary(
  rec: Record<string, unknown>,
  collectionOrScope?: string
): RecordSummary {
  const col = String(rec._collection || collectionOrScope || '').toLowerCase();

  if (typeof rec._probeTitle === 'string') {
    return {
      title: rec._probeTitle,
      badge: String(rec._probeBadge || 'Record'),
      snippet: String(rec._probeSnippet || '')
    };
  }

  if (
    col === 'sessions' ||
    (rec.title && (rec.messages || rec.messageCount !== undefined || rec.modelId))
  ) {
    return {
      title: String(rec.title || 'Untitled Session'),
      badge: String(rec.modelId || 'Built-in server'),
      snippet: `Messages: ${Array.isArray(rec.messages) ? rec.messages.length : (rec.messageCount ?? 'N/A')}`
    };
  }

  if (
    col === 'messages' ||
    col === 'conversations' ||
    (rec.role && rec.content !== undefined)
  ) {
    const role = String(rec.role || 'user').toUpperCase();
    const rawContent = String(rec.content || '');
    const cleanSnippet = rawContent.slice(0, 140).trim();
    const sessionLabel = rec.sessionTitle
      ? String(rec.sessionTitle)
      : rec.sessionId ? String(rec.sessionId).slice(0, 10) : 'session';
    return {
      title: `${role} Message (${sessionLabel})`,
      badge: role,
      snippet: cleanSnippet || '[No content text]'
    };
  }

  if (
    col === 'memories' ||
    col === 'directives' ||
    (rec.key && rec.fact !== undefined)
  ) {
    return {
      title: String(rec.key || 'Memory Fact'),
      badge: String(rec.category || 'directive'),
      snippet: String(rec.fact || '')
    };
  }

  if (col === 'vaultfiles' || col === 'filerepo' || rec.fileName || rec.sha256Preview) {
    return {
      title: String(rec.fileName || 'File'),
      badge: `${rec.chunkCount || 0} chunks`,
      snippet: `Collection: ${String(rec.collection || 'default')} · SHA: ${String(rec.sha256Preview || 'N/A')}`
    };
  }

  if (col === 'ragdocuments' || rec.chunkIndex !== undefined) {
    return {
      title: String(rec.title || 'Chunk'),
      badge: `Chunk #${rec.chunkIndex ?? 0}`,
      snippet: String(rec.text || '').slice(0, 140)
    };
  }

  if (col === 'customplugins' || (rec.id && rec.name && rec.description !== undefined)) {
    return {
      title: String(rec.name || 'Custom Tool'),
      badge: String(rec.id || 'tool'),
      snippet: String(rec.description || '')
    };
  }

  if (col === 'enginesettings' || rec.llamaCppBaseUrl !== undefined || rec.activeModelId !== undefined) {
    return {
      title: 'Engine Settings Snapshot',
      badge: 'System Config',
      snippet: `Active Model: ${String(rec.activeModelId || 'Default GGUF')} · Base URL: ${String(rec.llamaCppBaseUrl || '127.0.0.1:8080')}`
    };
  }

  return {
    title: String(rec.title || rec.name || rec.key || rec.id || 'Database Record'),
    badge: String(rec.badge || rec.category || rec.type || 'Record'),
    snippet: String(rec.snippet || rec.fact || rec.content || rec.description || JSON.stringify(rec).slice(0, 140))
  };
}

