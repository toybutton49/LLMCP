import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { readAttachmentWithGlmOcr } from './glmOcr';
import { AppError, toAppErrorPayload } from '../../src/utils/appErrors';
import { formatUploadLimitLabel } from '../../src/utils/ocrLimits';
import { APP_ENV } from '../config/env';
import { serverLogger } from '../config/logger';

const OCR_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);

export type OcrRunner = (inputPath: string, selectedModel?: string) => Promise<string>;

let previousOcr: Promise<void> = Promise.resolve();
export const runSerializedAttachmentOcr: OcrRunner = async (inputPath, selectedModel = '') => {
  const previous = previousOcr;
  let release!: () => void;
  previousOcr = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await readAttachmentWithGlmOcr(inputPath, selectedModel);
  } finally {
    release();
  }
};

export function registerAttachmentOcrRoute(
  app: Express,
  getStorageDirectory: () => string,
  runOcr: OcrRunner = runSerializedAttachmentOcr,
  getSelectedModel: () => string = () => ''
): void {
  app.post('/api/filerepo/ocr', async (req, res, next) => {
    try {
      const selectedModel = getSelectedModel();
      const result = await processAttachmentOcr(
        req.body,
        getStorageDirectory(),
        (inputPath) => runOcr(inputPath, selectedModel)
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });
}

export async function processAttachmentOcr(
  body: { fileName?: unknown; base64?: unknown },
  storageDirectory: string,
  runOcr: OcrRunner = runSerializedAttachmentOcr
): Promise<{ status: number; body: { text?: string; fileName?: string; error?: string; code?: string; feature?: string; action?: string } }> {
  const maxUploadBytes = APP_ENV.ocrMaxUploadBytes;
  const uploadLimitLabel = formatUploadLimitLabel(maxUploadBytes);
  const { fileName, base64 } = body || {};
  if (typeof fileName !== 'string' || fileName !== path.basename(fileName) ||
      fileName !== path.win32.basename(fileName) || fileName.startsWith('.') ||
      !OCR_EXTENSIONS.has(path.extname(fileName).toLowerCase()) ||
      typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(maxUploadBytes / 3) * 4) {
    const action = `Choose a supported PDF or image file no larger than ${uploadLimitLabel}.`;
    const error = new AppError(
      'INVALID_ATTACHMENT',
      'OCR',
      `Choose a PDF or supported image up to ${uploadLimitLabel}.`,
      action
    );
    return { status: 400, body: toAppErrorPayload(error, {
      code: 'INVALID_ATTACHMENT',
      feature: 'OCR',
      action
    }) };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > maxUploadBytes || bytes.toString('base64') !== base64) {
    const error = new AppError(
      'INVALID_ATTACHMENT',
      'OCR',
      'Invalid attachment data.',
      'Choose the file again and retry the upload.'
    );
    return { status: 400, body: toAppErrorPayload(error, {
      code: 'INVALID_ATTACHMENT',
      feature: 'OCR',
      action: 'Choose the file again and retry the upload.'
    }) };
  }

  const targetDir = path.resolve(process.cwd(), storageDirectory);
  let tempDir: string | undefined;
  try {
    await fs.mkdir(targetDir, { recursive: true });
    const alreadyExists = await fs.access(path.join(targetDir, fileName)).then(() => true, () => false);
    if (alreadyExists) {
      const error = new AppError(
        'FILE_ALREADY_EXISTS',
        'File Repo upload',
        `"${fileName}" already exists in File Repo. Existing files are not overwritten.`,
        'Rename the upload or remove the existing file before retrying.'
      );
      return { status: 409, body: toAppErrorPayload(error, {
        code: 'FILE_ALREADY_EXISTS',
        feature: 'File Repo upload',
        action: 'Rename the upload or remove the existing file before retrying.'
      }) };
    }
    tempDir = await fs.mkdtemp(path.join(targetDir, '.ocr-'));
    const inputPath = path.join(tempDir, fileName);
    await fs.writeFile(inputPath, bytes, { flag: 'wx' });
    const text = (await runOcr(inputPath)).trim();
    if (!text) throw new Error('No text was extracted from this file.');
    await fs.writeFile(path.join(targetDir, fileName), bytes, { flag: 'wx' });
    return { status: 200, body: { text, fileName } };
  } catch (error) {
    return { status: 422, body: {
      ...toAppErrorPayload(error, {
        code: 'OCR_FAILED',
        feature: 'OCR',
        messagePrefix: 'OCR or file storage failed: ',
        action: 'Check the GLM-OCR model and projector, then retry the upload.'
      }),
      feature: 'OCR'
    } };
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        serverLogger.warn('storage', `Failed to remove temporary OCR directory ${tempDir}`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
