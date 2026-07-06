/**
 * memnant — Embedding pipeline.
 *
 * Story 1.2: Generates embeddings for record content using a local model.
 * Uses @xenova/transformers with all-MiniLM-L6-v2 (384-dimensional, normalized).
 * The pipeline is lazily initialised on first call and cached in a module-level variable.
 */

import { pipeline, env } from '@xenova/transformers';
import { getRuntimeDir, isRuntimeReady, ensureRuntime } from './runtime-download.js';
import { join } from 'path';

// Force WASM backend when available (enables bun compile without native .dylib)
if (env.backends?.onnx) {
  env.backends.onnx.executionProviders = ['wasm'];
}

// Re-export utils so existing imports keep working
export { MODEL_NAME, serializeEmbedding, deserializeEmbedding } from './embedding-utils.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;

async function getPipeline() {
  if (!pipelineInstance) {
    // Check if we need to use standalone runtime (no native onnxruntime-node)
    const runtimeDir = getRuntimeDir();
    if (isRuntimeReady(runtimeDir)) {
      // Configure paths for standalone binary
      env.cacheDir = join(runtimeDir, 'models');
      env.localModelPath = join(runtimeDir, 'models');
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = join(runtimeDir, 'onnx') + '/';
      }
    } else {
      // Try to ensure runtime is available (downloads if needed)
      try {
        const dir = await ensureRuntime();
        env.cacheDir = join(dir, 'models');
        env.localModelPath = join(dir, 'models');
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.wasmPaths = join(dir, 'onnx') + '/';
        }
      } catch {
        // Fall back to default paths (npm install with native modules)
      }
    }

    process.stderr.write('Loading embedding model...\n');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return pipelineInstance;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}
