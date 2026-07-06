import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getRuntimeDir, isRuntimeReady, WASM_FILES, MODEL_FILES } from '../src/vector/runtime-download.js';

describe('runtime-download', () => {
  const testDir = join(tmpdir(), 'memnant-runtime-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('getRuntimeDir returns ~/.memnant/runtime by default', () => {
    const dir = getRuntimeDir();
    expect(dir).toContain('.memnant');
    expect(dir).toContain('runtime');
  });

  it('isRuntimeReady returns false when files are missing', () => {
    expect(isRuntimeReady(testDir)).toBe(false);
  });

  it('isRuntimeReady returns true when all files present', () => {
    // Create expected directory structure
    mkdirSync(join(testDir, 'onnx'), { recursive: true });
    mkdirSync(join(testDir, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx'), { recursive: true });

    for (const f of WASM_FILES) {
      writeFileSync(join(testDir, 'onnx', f), 'fake-wasm');
    }
    for (const f of MODEL_FILES) {
      writeFileSync(join(testDir, 'models', 'Xenova', 'all-MiniLM-L6-v2', f), 'fake-model');
    }

    expect(isRuntimeReady(testDir)).toBe(true);
  });

  it('exports expected file lists', () => {
    expect(WASM_FILES).toContain('ort-wasm-simd.wasm');
    expect(MODEL_FILES).toContain('onnx/model_quantized.onnx');
    expect(MODEL_FILES).toContain('tokenizer.json');
    expect(MODEL_FILES).toContain('config.json');
  });
});
