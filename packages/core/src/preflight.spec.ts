import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PhpLintRunner,
  PreflightError,
  type PreflightIssue,
  checkAll,
  checkFile,
} from './preflight.js';

describe('preflight checks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aiftp-preflight-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeLocal(path: string, content: string): Promise<string> {
    const filePath = join(tempDir, ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('passes valid JSON files', async () => {
    const filePath = await writeLocal('data.json', '{"ok": true}\n');

    await expect(checkFile(filePath)).resolves.toEqual({
      path: filePath,
      status: 'pass',
      issues: [],
    });
  });

  it('fails invalid JSON files', async () => {
    const filePath = await writeLocal('data.json', '{"ok": }\n');

    await expect(checkFile(filePath)).resolves.toMatchObject({
      path: filePath,
      status: 'fail',
      issues: [{ severity: 'error', kind: 'json' }],
    });
  });

  it('runs php -l through an injectable runner and fails syntax errors', async () => {
    const filePath = await writeLocal('contact.php', '<?php echo ;\n');
    const phpRunner: PhpLintRunner = async () => ({
      available: true,
      ok: false,
      message: 'PHP Parse error: syntax error',
    });

    await expect(checkFile(filePath, { phpRunner })).resolves.toEqual({
      path: filePath,
      status: 'fail',
      issues: [
        {
          severity: 'error',
          kind: 'php',
          message: 'PHP Parse error: syntax error',
        },
      ],
    });
  });

  it('skips PHP files gracefully when PHP CLI is unavailable', async () => {
    const filePath = await writeLocal('contact.php', '<?php echo "ok";\n');
    const phpRunner: PhpLintRunner = async () => ({
      available: false,
      ok: false,
      message: 'php command not found',
    });

    await expect(checkFile(filePath, { phpRunner })).resolves.toEqual({
      path: filePath,
      status: 'skip',
      issues: [
        {
          severity: 'warning',
          kind: 'php',
          message: 'PHP CLI unavailable; skipped php -l',
        },
      ],
    });
  });

  it('warns on HTML script/style tag imbalance by default', async () => {
    const filePath = await writeLocal('index.html', '<html><script>const a = 1;</html>\n');

    await expect(checkFile(filePath)).resolves.toMatchObject({
      path: filePath,
      status: 'warn',
      issues: [{ severity: 'warning', kind: 'html' }],
    });
  });

  it('fails HTML warnings when strictHtml is enabled', async () => {
    const filePath = await writeLocal('index.html', '<style>.hero { color: red; }</html>\n');

    await expect(checkFile(filePath, { strictHtml: true })).resolves.toMatchObject({
      path: filePath,
      status: 'fail',
      issues: [{ severity: 'error', kind: 'html' }],
    });
  });

  it('skips unsupported extensions', async () => {
    const filePath = await writeLocal('app.css', 'body { color: black; }\n');

    await expect(checkFile(filePath)).resolves.toEqual({
      path: filePath,
      status: 'skip',
      issues: [],
    });
  });

  it('aggregates multiple files and throws on failed reports', async () => {
    const validJson = await writeLocal('valid.json', '{"ok": true}\n');
    const invalidJson = await writeLocal('invalid.json', '{"ok": }\n');
    const htmlWarn = await writeLocal('index.html', '<script>missing close\n');

    const report = await checkAll([validJson, invalidJson, htmlWarn]);

    expect(report.ok).toBe(false);
    expect(report.results.map((result) => result.status)).toEqual(['pass', 'fail', 'warn']);
    expect(report.errors).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    expect(() => {
      if (!report.ok) {
        throw new PreflightError(report);
      }
    }).toThrow(PreflightError);
  });

  it('passes when all files are pass, warn, or skip and strict HTML is disabled', async () => {
    const validJson = await writeLocal('valid.json', '{"ok": true}\n');
    const htmlWarn = await writeLocal('index.html', '<script>missing close\n');
    const css = await writeLocal('app.css', 'body {}\n');

    const report = await checkAll([validJson, htmlWarn, css]);

    expect(report.ok).toBe(true);
    expect(report.warnings.map((issue: PreflightIssue) => issue.kind)).toEqual(['html']);
  });
});
