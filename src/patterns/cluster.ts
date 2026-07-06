/**
 * Union-find clustering for pattern detection.
 *
 * Groups records by embedding similarity using a union-find data structure.
 * Clusters with 3+ members are returned as potential patterns.
 */

import { dotProduct } from '../vector/search.js';

export interface ClusterInput {
  id: string;
  project_id: string;
  type: string;
  content_text: string;
  tags: string[];
  embedding: Float32Array;
}

export interface Cluster {
  records: ClusterInput[];
  centroidText: string;
  tags: string[];
}

const MIN_CLUSTER_SIZE = 3;

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px === py) return;
    if (this.rank[px] < this.rank[py]) {
      this.parent[px] = py;
    } else if (this.rank[px] > this.rank[py]) {
      this.parent[py] = px;
    } else {
      this.parent[py] = px;
      this.rank[px]++;
    }
  }
}

export function clusterRecords(records: ClusterInput[], threshold: number): Cluster[] {
  const n = records.length;
  if (n < MIN_CLUSTER_SIZE) return [];

  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = dotProduct(records[i].embedding, records[j].embedding);
      if (sim >= threshold) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: Cluster[] = [];
  for (const indices of groups.values()) {
    if (indices.length < MIN_CLUSTER_SIZE) continue;

    const clusterRecs = indices.map(i => records[i]);

    let bestIdx = 0;
    let bestAvg = -1;
    for (let i = 0; i < clusterRecs.length; i++) {
      let sum = 0;
      for (let j = 0; j < clusterRecs.length; j++) {
        if (i !== j) sum += dotProduct(clusterRecs[i].embedding, clusterRecs[j].embedding);
      }
      const avg = sum / (clusterRecs.length - 1);
      if (avg > bestAvg) {
        bestAvg = avg;
        bestIdx = i;
      }
    }

    const allTags = new Set<string>();
    for (const r of clusterRecs) {
      for (const t of r.tags) allTags.add(t);
    }

    clusters.push({
      records: clusterRecs,
      centroidText: clusterRecs[bestIdx].content_text,
      tags: [...allTags],
    });
  }

  return clusters;
}
