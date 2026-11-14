import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_ENV } from '../config/env';
import { scanLocalFilesystemModels, type DiscoveredGgufFile } from '../db/cryptoAndModels';
import { sendAuxiliaryRequest, startAuxiliaryLlamaServer, type AuxiliaryLlamaServer } from '../llamacpp/auxiliaryServer';
import { renderOcrPages, type OcrPage } from './ocrPages';
import { assertNotLfsPointer, classifyGgufRole } from '../db/ggufMetadata';

export interface GlmOcrModel {
  model: string;
  projector: string;
}

type OcrRequest = (server: AuxiliaryLlamaServer, payload: object) => Promise<unknown>;

const GLM_OCR_PROMPT = 'Text Recognition: Transcribe all visible text in reading order. Include every section, heading, label, number, currency amount, and date. Do not summarize or omit any visible text.';

export async function sendGlmOcrRequest(server: AuxiliaryLlamaServer, payload: object): Promise<unknown> {
  return sendAuxiliaryRequest(server, '/v1/chat/completions', payload, 'GLM-OCR');
}

export async function findGlmOcrModel(
  ocrFiles: DiscoveredGgufFile[] = scanLocalFilesystemModels().ocrFiles,
  selectedFileName = ''
): Promise<GlmOcrModel> {
  const modelsDir = APP_ENV.modelsDir;
  const glmFiles = ocrFiles.filter((file) => file.fileName.toLowerCase().includes('glm-ocr'));
  const selected = selectedFileName ? glmFiles.filter((file) => file.fileName === selectedFileName) : [];
  if (selectedFileName && !selected.length && glmFiles.length) {
    throw new Error(`Selected OCR model "${selectedFileName}" was not found in ${modelsDir}.`);
  }
  const candidates = selected.length ? selected : glmFiles;
  if (!candidates.length) {
    throw new Error(`GLM-OCR model not found. Install a compatible GLM-OCR GGUF and matching mmproj GGUF in ${modelsDir}.`);
  }
  if (candidates.length !== 1) throw new Error('Multiple GLM-OCR GGUF models found; select one in Settings > Knowledge or leave one in the models directory.');
  const model = path.resolve(process.cwd(), candidates[0].relativePath);
  const directory = path.dirname(model);
  const siblingEntries = await fs.readdir(directory);
  const glmProjectors = siblingEntries.filter((name) =>
    name.toLowerCase().startsWith('mmproj-glm-ocr') && name.toLowerCase().endsWith('.gguf')
  );
  const projectors = glmProjectors.length > 0
    ? glmProjectors
    : siblingEntries.filter((name) => {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.gguf') || name === path.basename(model)) return false;
        const full = path.join(directory, name);
        return lower.startsWith('mmproj') || classifyGgufRole(full) === 'projector';
      });
  if (projectors.length !== 1) throw new Error('GLM-OCR requires a unique matching mmproj GGUF beside the model.');
  const projector = path.join(directory, projectors[0]);
  assertNotLfsPointer(model);
  assertNotLfsPointer(projector);
  return { model, projector };
}

export async function startGlmOcrServer(model: GlmOcrModel): Promise<AuxiliaryLlamaServer> {
  return startAuxiliaryLlamaServer([
    '-m', model.model, '--mmproj', model.projector,
    '--no-warmup', '-ngl', '0', '--no-mmproj-offload', '-c', String(APP_ENV.ocrContextSize),
    '--parallel', '1'
  ], 'GLM-OCR');
}

export async function readImageWithGlmOcr(
  inputPath: string,
  model: GlmOcrModel,
  startServer: (model: GlmOcrModel) => Promise<AuxiliaryLlamaServer> = startGlmOcrServer,
  sendRequest: OcrRequest = sendGlmOcrRequest
): Promise<string> {
  const extension = path.extname(inputPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.bmp'].includes(extension)) {
    throw new Error('GLM-OCR supports PNG, JPEG and BMP image attachments.');
  }
  const mime = extension === '.png' ? 'image/png' : extension === '.bmp' ? 'image/bmp' : 'image/jpeg';
  const bytes = await fs.readFile(inputPath);
  return readPagesWithGlmOcr([{ bytes, mime }], model, startServer, sendRequest);
}

export async function readPagesWithGlmOcr(
  pages: AsyncIterable<OcrPage> | Iterable<OcrPage>,
  model: GlmOcrModel,
  startServer: (model: GlmOcrModel) => Promise<AuxiliaryLlamaServer> = startGlmOcrServer,
  sendRequest: OcrRequest = sendGlmOcrRequest
): Promise<string> {
  const server = await startServer(model);
  try {
    const results: string[] = [];
    for await (const { bytes, mime } of pages) {
      const data = await sendRequest(server, {
        model: path.basename(model.model),
        messages: [{ role: 'user', content: [
          { type: 'text', text: GLM_OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
        ] }],
        max_tokens: APP_ENV.ocrMaxTokens,
        temperature: 0,
        stream: false
      });
      if (!data || typeof data !== 'object' || !('choices' in data) || !Array.isArray(data.choices)) {
        throw new Error('GLM-OCR returned an invalid response.');
      }
      if (data.choices[0]?.finish_reason === 'length') throw new Error('GLM-OCR output exceeded its token limit.');
      const text = data.choices[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('GLM-OCR returned no text.');
      results.push(text.trim());
    }
    if (!results.length) throw new Error('No pages were found in this attachment.');
    return results.join('\n\n');
  } finally {
    await server.stop();
  }
}

export async function readAttachmentWithGlmOcr(inputPath: string, selectedFileName = ''): Promise<string> {
  const model = await findGlmOcrModel(undefined, selectedFileName);
  return readPagesWithGlmOcr(renderOcrPages(inputPath), model);
}
