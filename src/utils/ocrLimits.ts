import { OCR_DEFAULTS } from '../data/runtimeDefaults';

// The OCR model processes one rendered page at a time, so the model does not need a small file cap.
// This limit only bounds the base64 JSON request; page and pixel limits are enforced during OCR.
export const OCR_MAX_UPLOAD_BYTES = OCR_DEFAULTS.maxUploadBytes;
export const OCR_MAX_PAGES = OCR_DEFAULTS.maxPages;
export const OCR_MAX_PIXELS = OCR_DEFAULTS.maxPixelsPerPage;

export function formatUploadLimitLabel(maxBytes: number = OCR_MAX_UPLOAD_BYTES): string {
  const mb = maxBytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export const OCR_UPLOAD_LIMIT_LABEL = formatUploadLimitLabel(OCR_MAX_UPLOAD_BYTES);
