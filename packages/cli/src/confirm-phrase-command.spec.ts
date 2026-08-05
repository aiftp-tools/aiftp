import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsableConfirmPhrase } from '@aiftp-tools/mcp';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_PHRASE_ALPHABET,
  CONFIRM_PHRASE_ENTROPY_BITS,
  CONFIRM_PHRASE_GROUP_COUNT,
  CONFIRM_PHRASE_GROUP_LENGTH,
  generateConfirmPhrase,
  registerConfirmPhraseCommand,
} from './confirm-phrase-command.js';

describe('generateConfirmPhrase', () => {
  it('produces a phrase the MCP gate accepts, every time', () => {
    // The generator exists so the recommended path is a generated secret;
    // a generated phrase that the gate then rejects would be worse than no
    // generator at all.
    for (let i = 0; i < 500; i += 1) {
      expect(isUsableConfirmPhrase(generateConfirmPhrase())).toBe(true);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateConfirmPhrase()));
    expect(seen.size).toBe(200);
  });

  it('uses a fixed, hyphen-grouped shape', () => {
    const group = `[${CONFIRM_PHRASE_ALPHABET}]{${CONFIRM_PHRASE_GROUP_LENGTH}}`;
    const pattern = new RegExp(`^${group}(?:-${group}){${CONFIRM_PHRASE_GROUP_COUNT - 1}}$`, 'u');
    for (let i = 0; i < 100; i += 1) {
      expect(generateConfirmPhrase()).toMatch(pattern);
    }
  });

  it('backs its entropy claim with the arithmetic', () => {
    // Every drawn character is uniform over the alphabet, so the entropy is
    // exactly count * length * log2(|alphabet|). The hyphens are fixed and
    // contribute nothing.
    expect(CONFIRM_PHRASE_ALPHABET.length).toBe(32);
    expect(new Set(CONFIRM_PHRASE_ALPHABET).size).toBe(CONFIRM_PHRASE_ALPHABET.length);
    expect(CONFIRM_PHRASE_GROUP_COUNT * CONFIRM_PHRASE_GROUP_LENGTH).toBe(30);
    expect(CONFIRM_PHRASE_ENTROPY_BITS).toBe(
      CONFIRM_PHRASE_GROUP_COUNT *
        CONFIRM_PHRASE_GROUP_LENGTH *
        Math.log2(CONFIRM_PHRASE_ALPHABET.length),
    );
    expect(CONFIRM_PHRASE_ENTROPY_BITS).toBe(150);
    expect(CONFIRM_PHRASE_ENTROPY_BITS).toBeGreaterThanOrEqual(128);
  });

  it('omits the characters a human would misread', () => {
    for (const ambiguous of ['I', 'O', '0', '1']) {
      expect(CONFIRM_PHRASE_ALPHABET).not.toContain(ambiguous);
    }
  });
});

describe('aiftp confirm-phrase generate', () => {
  async function run(): Promise<{ stdout: string[]; stderr: string[] }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerConfirmPhraseCommand(program, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    await program.parseAsync(['node', 'aiftp', 'confirm-phrase', 'generate'], { from: 'node' });
    return { stdout, stderr };
  }

  it('prints the phrase alone on stdout so it can be piped or selected', async () => {
    const { stdout } = await run();
    expect(stdout).toHaveLength(1);
    expect(isUsableConfirmPhrase(stdout[0])).toBe(true);
  });

  it('prints the handling instructions on stderr, including the do-not-show warning', async () => {
    const { stdout, stderr } = await run();
    const guidance = stderr.join('\n');
    expect(guidance).toContain('Claude Desktop');
    expect(guidance).toMatch(/do not (show|display)/i);
    expect(guidance).toMatch(/slide|shared screen/i);
    // The guidance must not repeat the secret: stderr and stdout are often
    // merged into one terminal scrollback, but they are also often captured
    // separately, and the phrase belongs on exactly one of them.
    expect(guidance).not.toContain(stdout[0]);
  });

  it('takes no arguments, so a secret can never be passed in on the command line', async () => {
    const program = new Command();
    program.exitOverride();
    registerConfirmPhraseCommand(program, { stdout: () => {}, stderr: () => {} });
    const generate = program.commands
      .find((command) => command.name() === 'confirm-phrase')
      ?.commands.find((command) => command.name() === 'generate');
    expect(generate).toBeDefined();
    expect(generate?.registeredArguments ?? []).toHaveLength(0);
    expect(generate?.options ?? []).toHaveLength(0);
  });
});

describe('generator reachability', () => {
  it('is not referenced anywhere in the MCP server', async () => {
    // Binding constraint: a generated phrase must never pass through an MCP
    // tool, prompt, resource or log -- it would enter the model's context
    // before the human ever used it. Enforced structurally: the MCP package
    // does not know this module exists.
    const mcpSrc = fileURLToPath(new URL('../../mcp/src/', import.meta.url));
    const entries = await readdir(mcpSrc, { withFileTypes: true });
    const sources = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(3);
    for (const source of sources) {
      const text = await readFile(join(mcpSrc, source.name), 'utf8');
      expect(text).not.toContain('generateConfirmPhrase');
      expect(text).not.toContain('confirm-phrase-command');
    }
  });

  it('is not exported from the MCP package', async () => {
    const mcp = (await import('@aiftp-tools/mcp')) as Record<string, unknown>;
    expect(Object.keys(mcp)).not.toContain('generateConfirmPhrase');
  });
});
