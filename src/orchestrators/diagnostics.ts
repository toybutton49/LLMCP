import type {
  LocalProviderId,
  PluginDefinition,
  RagDocumentInput,
  VaultFileEntry
} from '../utils/rag';
import type { OrchestratorDiagnosticReport } from './types';
import { ChatOrchestrator } from './chatOrchestrator';
import { PromptIntakeOrchestrator } from './intakeOrchestrator';
import { KnowledgeOrchestrator } from './knowledgeOrchestrator';
import { MemoryOrchestrator } from './memoryOrchestrator';
import { ContextOrchestrator } from './contextOrchestrator';
import { ToolOrchestrator } from './toolOrchestrator';
import { AnalyticsOrchestrator } from './analyticsOrchestrator';
import { StorageOrchestrator } from './storageOrchestrator';
import { LoggingOrchestrator } from './loggingOrchestrator';

export interface DiagnosticsContext {
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  customPlugins: PluginDefinition[];
  activeProviderId: LocalProviderId;
  activeModelId: string;
}

export interface DiagnosticOrchestrators {
  chat: ChatOrchestrator;
  intake: PromptIntakeOrchestrator;
  knowledge: KnowledgeOrchestrator;
  memory: MemoryOrchestrator;
  context: ContextOrchestrator;
  tools: ToolOrchestrator;
  analytics: AnalyticsOrchestrator;
  storage: StorageOrchestrator;
  logging: LoggingOrchestrator;
}

export function runOrchestratorDiagnostics(
  arms: DiagnosticOrchestrators,
  context: DiagnosticsContext
): OrchestratorDiagnosticReport {
  const start = performance.now();
  const testIntake = arms.intake.normalize({ rawText: 'Verify Nervous System prompt intake signal.' });
  const diagnosticSession = arms.chat.createFreshDefaultSession(context.activeModelId);
  const diagnosticMessage = arms.chat.createMessage({
    sessionId: 'diagnostics',
    role: 'user',
    content: 'Exercise chat message construction without persisting or sending inference.',
    modelId: context.activeModelId
  });
  const testIndex = arms.knowledge.index({
    documents: context.ragDocuments.length > 0 ? context.ragDocuments.slice(0, 1) : [{
      id: 'diagnostic-document',
      title: 'Diagnostic fixture',
      category: 'diagnostics',
      content: 'Local knowledge indexing diagnostic fixture.'
    }],
    files: context.vaultFiles.slice(0, 1),
    chunkSize: 420,
    chunkOverlap: 60,
    similarityMetric: 'cosine'
  });
  const schemas = arms.tools.getCallableSchemas([
    'system_context', 'web_search', 'precision_calculator'
  ]);
  const testContext = arms.context.assemble({
    userPrompt: 'Exercise context assembly.',
    session: diagnosticSession,
    historyMessages: [],
    memories: [],
    ragDocuments: [],
    vaultFiles: [],
    customPlugins: context.customPlugins
  });
  const memoryProbe = arms.memory.probeDatabase({
    query: 'Exercise local conversation memory probing.',
    messagesBySession: {
      diagnostics: [{
        ...diagnosticMessage,
        content: 'A deterministic memory diagnostic fixture for local conversation retrieval.'
      }]
    },
    sessions: [{ ...diagnosticSession, id: 'diagnostics' }],
    currentSessionId: 'diagnostics',
    scope: 'conversations',
    topK: 1,
    minSimilarityScore: 0,
    maxTokens: 100
  });
  const analytics = arms.analytics.computeWorkspaceAnalytics({
    sessions: [diagnosticSession],
    messagesBySession: { [diagnosticSession.id]: [diagnosticMessage] },
    ragDocuments: [],
    vaultFiles: [],
    memories: []
  });
  const serializedSnapshot = arms.storage.serializeSnapshot(
    arms.storage.createFreshInstallSnapshot()
  );
  const parsedSnapshot = arms.storage.parseSnapshot(serializedSnapshot);
  const storagePassed = Boolean(parsedSnapshot && Array.isArray(parsedSnapshot.sessions));
  const baselineLatency = Math.round((performance.now() - start) * 100) / 100;
  const statuses = [
    testIntake.telemetry.status,
    testIndex.telemetry.status,
    testContext.telemetry.status,
    diagnosticMessage.role === 'user' ? 'success' : 'error',
    schemas.length > 0 ? 'success' : 'error',
    Array.isArray(memoryProbe.hits) ? 'success' : 'error',
    analytics.totalMessages === 1 ? 'success' : 'error',
    storagePassed ? 'success' : 'error'
  ];
  const status = statuses.includes('error') ? 'degraded' : 'healthy';
  const successfulChecks = statuses.filter((item) => item === 'success').length;
  arms.logging.info(
    'system',
    'diagnostics.completed',
    `Octopus self-test completed in ${baselineLatency} ms (${successfulChecks} local checks passed; live inference was not run).`,
    { durationMs: baselineLatency, metadata: { successfulChecks } }
  );

  return {
    timestamp: new Date().toISOString(),
    version: '7.0.0-octopus',
    health: status,
    status,
    modules: {
      chat: {
        status: diagnosticMessage.role === 'user' ? 'success' : 'error',
        defaultToolsCount: arms.chat.defaultPluginIds.length,
        details: 'Message construction exercised; chat inference was not invoked.'
      },
      intake: {
        status: testIntake.telemetry.status,
        estimatedTokens: testIntake.result.estimatedTokens,
        details: testIntake.telemetry.summary
      },
      context: {
        status: testContext.telemetry.status,
        estimatedTokens: testContext.output.tokenBudget.totalAssembledTokens,
        details: `${testContext.telemetry.summary} Synthetic fixture; no runtime model or GPU context was loaded.`
      },
      tool: {
        status: schemas.length > 0 ? 'success' : 'error',
        availableCount: arms.tools.getAllAvailablePlugins().length,
        activeCount: schemas.length,
        details: 'Callable tool schemas prepared; only schema registration is checked here, not external/network tool execution.'
      },
      knowledge: {
        status: testIndex.telemetry.status,
        indexedDocs: testIndex.result.totalDocs,
        indexedFiles: testIndex.result.totalFiles,
        details: 'Local index construction exercised; Nomic model-backed retrieval is checked separately by live retrieval.'
      },
      memory: {
        status: Array.isArray(memoryProbe.hits) ? 'success' : 'error',
        defaultTemplatesCount: arms.memory.getDefaultTemplates().length,
        details: 'Local deterministic conversation probe exercised; persistent Nomic vector retrieval is not checked here.'
      },
      analytics: {
        status: analytics.totalMessages === 1 ? 'success' : 'error',
        details: `Workspace usage calculation exercised (${analytics.totalMessages} diagnostic message).`
      },
      storage: {
        status: storagePassed ? 'success' : 'error',
        schemaKeysCount: Object.keys(parsedSnapshot ?? {}).length,
        details: 'Workspace snapshot serialize/parse exercised; server sync is not tested here.'
      },
      inference: {
        status: 'pending',
        provider: context.activeProviderId,
        model: context.activeModelId || 'none selected',
        details: 'Not run by design (no model load or GPU use during self-test). Chat itself is the live inference check.'
      },
      logging: {
        status: 'success',
        bufferedLogs: arms.logging.getEntries().length,
        details: 'Client log buffer read successfully.'
      }
    },
    latencyBaselineMs: baselineLatency
  };
}
