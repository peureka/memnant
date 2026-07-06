/**
 * memnant — Embedding utilities.
 *
 * Lightweight serialization/deserialization and model constants.
 * Zero dependency on @xenova/transformers — safe to import on any code path.
 */

export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function deserializeEmbedding(buffer: Uint8Array): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return new Float32Array(arrayBuffer);
}
