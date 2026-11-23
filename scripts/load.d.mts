/** Types of `scripts/load.mjs` for the in-process bounded run in `tests/unit/cycle8Load.test.ts`. */
export interface LoadParams {
  volume: number;
  timedRuns: number;
  clients: number;
  burst: number;
  readIterations: number;
  maxRuns: number;
  maxBurst: number;
  revokeAfterMs?: number;
}

export interface LoadCheck {
  target: string;
  limit: number | string;
  measured: unknown;
  pass: boolean;
  note: string;
}

export interface LoadReport {
  generatedAt: string;
  mode: string;
  host: { os: string; cpuModel: string; cores: number; totalMemoryBytes: number; node: string };
  params: LoadParams;
  measurements: Record<string, any>;
  targets: Record<string, number>;
  results: LoadCheck[];
  pass: boolean;
}

export interface LoadConfig {
  baseUrl: string;
  tokenFor(sub: string): string;
  /** One administrator subject per security domain (already provisioned in that domain). */
  admins: Record<string, string>;
  limits: any;
  params: LoadParams;
  mode?: string;
  /** A bounded run smaller than the pinned volume and client count; only those two targets are scaled, and the report says so. */
  scaledDown?: boolean;
  log?(message: string): void;
}

export function runLoad(cfg: LoadConfig): Promise<LoadReport>;
export function percentile(values: number[], p: number): number | null;
export function readOperationalLimits(pack?: string): any;
export function sizedVariant(n: number, totalBytes: number, fixtures?: string): { batch: string; erp: Buffer; lab: Buffer };
export function variant(n: number, fixtures?: string): { batch: string; erp: Buffer; lab: Buffer };
