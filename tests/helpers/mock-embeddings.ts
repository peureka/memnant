/**
 * Deterministic mock embedding generator for tests.
 *
 * Replaces the real @xenova/transformers pipeline with a bag-of-words
 * generator that produces consistent 384-dim unit vectors. Words are
 * hashed to vector contributions, so texts sharing words have non-zero
 * cosine similarity — enough to satisfy link/search threshold tests.
 */

const DIMS = 384;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

export function mockGenerateEmbedding(text: string): Float32Array {
  const vec = new Float32Array(DIMS);

  // Bag-of-words: each word contributes deterministically to the vector
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 1);

  for (const word of words) {
    const hash = hashString(word);
    const rng = seededRandom(hash);
    for (let i = 0; i < DIMS; i++) {
      vec[i] += rng() * 2 - 1;
    }
  }

  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIMS; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}
