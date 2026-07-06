/**
 * memnant doctor — Types for infrastructure diagnostics.
 */

export type FindingSeverity = 'error' | 'warning' | 'info';

export type FindingCode =
  | 'DIST_MISSING'
  | 'DIST_STALE'
  | 'LEDGER_MISSING'
  | 'CONFIG_MISSING'
  | 'MCP_ENTRY_MISSING'
  | 'NPM_LINK_MISSING'
  | 'REGISTRY_STALE'
  | 'PROJECT_DIR_MISSING';

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  project?: string;
  path?: string;
  message: string;
  fixable: boolean;
  fix_description?: string;
}

export interface DoctorReport {
  checked_at: string;
  memnant_version: string;
  findings: Finding[];
  projects_checked: number;
  projects_healthy: number;
}
