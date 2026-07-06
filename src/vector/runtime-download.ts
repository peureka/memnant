/**
 * memnant — Runtime downloader.
 *
 * Downloads ONNX WASM files and embedding model on first use.
 * Files are cached in ~/.memnant/runtime/ and reused on subsequent runs.
 */

import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pipeline as streamPipeline } from 'stream/promises';
import { Readable } from 'stream';

export const WASM_FILES = [
  'ort-wasm-simd.wasm',
];

export const MODEL_FILES = [
  'onnx/model_quantized.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
];

const ONNX_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist';
const MODEL_CDN = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main';

export function getRuntimeDir(): string {
  return join(homedir(), '.memnant', 'runtime');
}

export function isRuntimeReady(runtimeDir?: string): boolean {
  const dir = runtimeDir ?? getRuntimeDir();

  for (const f of WASM_FILES) {
    if (!existsSync(join(dir, 'onnx', f))) return false;
  }
  for (const f of MODEL_FILES) {
    if (!existsSync(join(dir, 'models', 'Xenova', 'all-MiniLM-L6-v2', f))) return false;
  }
  return true;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const dir = dest.substring(0, dest.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  if (!res.body) throw new Error(`No body in response from ${url}`);

  const writer = createWriteStream(dest);
  await streamPipeline(Readable.fromWeb(res.body as any), writer);
}

export async function ensureRuntime(runtimeDir?: string): Promise<string> {
  const dir = runtimeDir ?? getRuntimeDir();

  if (isRuntimeReady(dir)) return dir;

  process.stderr.write('Downloading embedding runtime...');

  // Download WASM files
  for (const f of WASM_FILES) {
    const dest = join(dir, 'onnx', f);
    if (!existsSync(dest)) {
      await downloadFile(`${ONNX_CDN}/${f}`, dest);
    }
  }

  // Download model files
  for (const f of MODEL_FILES) {
    const dest = join(dir, 'models', 'Xenova', 'all-MiniLM-L6-v2', f);
    if (!existsSync(dest)) {
      await downloadFile(`${MODEL_CDN}/${f}`, dest);
    }
  }

  process.stderr.write(' done.\n');
  return dir;
}
