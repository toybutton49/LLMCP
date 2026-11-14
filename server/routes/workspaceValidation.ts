export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function recordsHaveStrings(value: unknown, keys: string[]): boolean {
  return Array.isArray(value) && value.every((record: unknown) =>
    isRecord(record) && keys.every((key) => typeof record[key] === 'string'));
}

export function validateWorkspaceSync(input: unknown): string | null {
  if (!isRecord(input)) return 'Workspace sync requires a JSON object.';
  for (const key of ['uiState', 'ragConfig', 'engineSettings', 'branding']) {
    if (input[key] !== undefined && !isRecord(input[key])) return `${key} must be an object.`;
  }
  const collections: Record<string, string[]> = {
    sessions: ['id', 'title', 'modelId'],
    ragDocuments: ['id', 'title', 'category', 'content'],
    vaultFiles: ['id', 'fileName', 'content', 'collection'],
    vaultMatrixColumns: ['id', 'header', 'extractionRule'],
    memories: ['id', 'key', 'fact', 'category'],
    promptTemplates: ['id', 'name', 'systemPrompt'],
    customPlugins: ['id', 'name', 'category', 'description', 'parameterSummary']
  };
  for (const [key, fields] of Object.entries(collections)) {
    if (input[key] !== undefined && !recordsHaveStrings(input[key], fields)) {
      return `${key} must be an array of valid records.`;
    }
  }
  if (Array.isArray(input.sessions) && !input.sessions.every((session: Record<string, unknown>) =>
    Array.isArray(session.enabledPluginIds) && session.enabledPluginIds.every((id: unknown) => typeof id === 'string'))) {
    return 'sessions must include valid enabledPluginIds.';
  }
  if (input.messagesBySession !== undefined) {
    if (!isRecord(input.messagesBySession) ||
        !Object.values(input.messagesBySession).every((messages) =>
          Array.isArray(messages) && messages.every((message: unknown) =>
            isRecord(message) && typeof message.id === 'string' &&
            typeof message.content === 'string' && typeof message.role === 'string' &&
            ['user', 'assistant', 'system'].includes(message.role)))) {
      return 'messagesBySession must contain arrays of valid messages.';
    }
  }
  return null;
}
