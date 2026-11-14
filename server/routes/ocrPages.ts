import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { OCR_DEFAULTS } from '../../src/data/runtimeDefaults';
import { APP_ENV } from '../config/env';

export interface OcrPage {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg' | 'image/bmp';
}

export async function* renderOcrPages(inputPath: string): AsyncGenerator<OcrPage> {
  const maxPages = APP_ENV.ocrMaxPages;
  const maxPixels = APP_ENV.ocrMaxPixelsPerPage;
  const bytes = await fs.readFile(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const document = await loadingTask.promise;
    try {
      if (document.numPages < 1 || document.numPages > maxPages) {
        throw new Error(`PDF must contain between 1 and ${maxPages} pages.`);
      }
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(OCR_DEFAULTS.pdfRenderScale, Math.sqrt(maxPixels / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        if (!width || !height || width * height > maxPixels + width + height) {
          throw new Error(`PDF page ${number} has invalid dimensions.`);
        }
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        await page.render({
          canvas: null,
          // pdf.js types this as a browser canvas; the native canvas implements its rendering API.
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise;
        yield { bytes: canvas.toBuffer('image/png'), mime: 'image/png' };
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }
    return;
  }
  if (ext === '.bmp') {
    if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM' ||
        bytes.readUInt32LE(14) < 40) throw new Error('Unsupported or invalid BMP image.');
    const width = bytes.readInt32LE(18);
    const height = Math.abs(bytes.readInt32LE(22));
    if (width <= 0 || !height || width * height > maxPixels) throw new Error('BMP image exceeds the pixel limit.');
    yield { bytes, mime: 'image/bmp' };
    return;
  }
  const metadata = await sharp(bytes, { animated: true, limitInputPixels: maxPixels * maxPages }).metadata();
  const pages = metadata.pages || 1;
  if (pages > maxPages) throw new Error(`Image must contain at most ${maxPages} pages.`);
  for (let page = 0; page < pages; page++) {
    const image = sharp(bytes, { page, pages: 1, limitInputPixels: maxPixels });
    yield { bytes: await image.rotate().flatten({ background: '#ffffff' }).png().toBuffer(), mime: 'image/png' };
  }
}
