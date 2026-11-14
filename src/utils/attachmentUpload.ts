import { createVaultFileEntry, isBinaryOrImageFile, type VaultFileEntry } from './rag';
import { AppError, readAppError } from './appErrors';
import { fetchRuntimeStatus } from './runtimeTelemetry';
import { OCR_MAX_UPLOAD_BYTES, OCR_UPLOAD_LIMIT_LABEL } from './ocrLimits';

const OCR_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'];

async function postJson(url: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Server returned ${response.status} with an invalid response.`);
  }
  if (!data || typeof data !== 'object') throw new Error('Invalid server response.');
  const result = data as Record<string, unknown>;
  if (!response.ok) throw new Error(readAppError(result, `Server returned ${response.status}.`));
  return result;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onabort = () => reject(new Error('File reading was cancelled.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('Could not read the file.'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadAttachment(file: File, collection: string): Promise<VaultFileEntry> {
  if (file.name.toLowerCase().endsWith('.gguf')) {
    throw new Error('Model weights are not attachments. Copy the file to ./models, then scan in Settings.');
  }
  if (isBinaryOrImageFile(file.name, file.type)) {
    if (!OCR_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      throw new Error('This binary file type cannot be read as chat context.');
    }
    if (file.size > OCR_MAX_UPLOAD_BYTES) {
      throw new Error(`PDF and image uploads are limited to ${OCR_UPLOAD_LIMIT_LABEL}.`);
    }
    const status = await fetchRuntimeStatus('', '', undefined, true);
    if (!status.models?.ocr.available) {
      throw new AppError(
        'OCR_MODEL_UNAVAILABLE',
        'OCR',
        status.models?.ocr.error || 'GLM-OCR and its matching projector are unavailable.',
        status.models?.ocr.action || 'Install GLM-OCR and its matching projector in ./models, then retry the upload.'
      );
    }
    const result = await postJson('/api/filerepo/ocr', { fileName: file.name, base64: await readBase64(file) });
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No text was extracted.');
    return createVaultFileEntry({
      fileName: `${file.name}.ocr.txt`,
      collection,
      content: `Extracted text from ${file.name}:\n\n${result.text}`,
      pinnedInChat: false
    });
  }
  const content = await file.text();
  await postJson('/api/filerepo/write', { fileName: file.name, content, collection });
  return createVaultFileEntry({ fileName: file.name, collection, content, pinnedInChat: false });
}
