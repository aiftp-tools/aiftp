import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type PreflightSeverity = 'error' | 'warning';
export type PreflightKind = 'json' | 'php' | 'html';

export interface PreflightIssue {
  severity: PreflightSeverity;
  kind: PreflightKind;
  message: string;
}

export interface PreflightResult {
  path: string;
  status: PreflightStatus;
  issues: PreflightIssue[];
}

export interface PreflightReport {
  ok: boolean;
  results: PreflightResult[];
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
}

export interface PhpLintResult {
  available: boolean;
  ok: boolean;
  message: string;
}

export type PhpLintRunner = (path: string) => Promise<PhpLintResult>;

export interface PreflightOptions {
  phpRunner?: PhpLintRunner;
  strictHtml?: boolean;
}

export class PreflightError extends Error {
  readonly report: PreflightReport;

  constructor(report: PreflightReport) {
    super(`Preflight failed with ${report.errors.length} error(s)`);
    this.name = 'PreflightError';
    this.report = report;
  }
}

function result(
  path: string,
  status: PreflightStatus,
  issues: PreflightIssue[] = [],
): PreflightResult {
  return { path, status, issues };
}

async function defaultPhpRunner(path: string): Promise<PhpLintResult> {
  try {
    const { stdout, stderr } = await execFileAsync('php', ['-l', path], { maxBuffer: 1024 * 1024 });
    return {
      available: true,
      ok: true,
      message: [stdout, stderr].filter(Boolean).join('\n').trim(),
    };
  } catch (error: unknown) {
    const err = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.code === 'ENOENT') {
      return {
        available: false,
        ok: false,
        message: 'php command not found',
      };
    }
    return {
      available: true,
      ok: false,
      message: [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim(),
    };
  }
}

async function checkJson(path: string): Promise<PreflightResult> {
  try {
    JSON.parse(await readFile(path, 'utf8'));
    return result(path, 'pass');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return result(path, 'fail', [{ severity: 'error', kind: 'json', message }]);
  }
}

async function checkPhp(path: string, phpRunner: PhpLintRunner): Promise<PreflightResult> {
  const lint = await phpRunner(path);
  if (!lint.available) {
    return result(path, 'skip', [
      {
        severity: 'warning',
        kind: 'php',
        message: 'PHP CLI unavailable; skipped php -l',
      },
    ]);
  }
  if (lint.ok) {
    return result(path, 'pass');
  }
  return result(path, 'fail', [
    {
      severity: 'error',
      kind: 'php',
      message: lint.message || 'PHP syntax check failed',
    },
  ]);
}

function htmlIssues(source: string, strictHtml: boolean): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const pairs = [
    ['script', /<script\b[^>]*>/giu, /<\/script>/giu],
    ['style', /<style\b[^>]*>/giu, /<\/style>/giu],
  ] as const;

  for (const [tag, openPattern, closePattern] of pairs) {
    const opens = source.match(openPattern)?.length ?? 0;
    const closes = source.match(closePattern)?.length ?? 0;
    if (opens !== closes) {
      issues.push({
        severity: strictHtml ? 'error' : 'warning',
        kind: 'html',
        message: `<${tag}> tag imbalance: open=${opens} close=${closes}`,
      });
    }
  }

  return issues;
}

async function checkHtml(path: string, strictHtml: boolean): Promise<PreflightResult> {
  const issues = htmlIssues(await readFile(path, 'utf8'), strictHtml);
  if (issues.length === 0) {
    return result(path, 'pass');
  }
  return result(path, strictHtml ? 'fail' : 'warn', issues);
}

export async function checkFile(
  path: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') {
    return checkJson(path);
  }
  if (extension === '.php') {
    return checkPhp(path, options.phpRunner ?? defaultPhpRunner);
  }
  if (extension === '.html' || extension === '.htm') {
    return checkHtml(path, options.strictHtml ?? false);
  }
  return result(path, 'skip');
}

export async function checkAll(
  paths: readonly string[],
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const results = await Promise.all(paths.map((path) => checkFile(path, options)));
  const issues = results.flatMap((entry) => entry.issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return {
    ok: errors.length === 0,
    results,
    errors,
    warnings,
  };
}
