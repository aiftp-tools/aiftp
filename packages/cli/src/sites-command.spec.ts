import { basename, join } from 'node:path';
import {
  type DoctorReport,
  type ResolvedSite,
  type SiteEntry,
  SiteRegistryDuplicateError,
} from '@aiftp-tools/core';
import { Command, type CommanderError } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SiteRegistrySurface,
  type SitesCommandDeps,
  registerSitesCommand,
} from './sites-command.js';

const passingDoctorReport: DoctorReport = {
  ok: true,
  results: [],
  summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
};

function resolved(entry: SiteEntry, overrides: Partial<ResolvedSite> = {}): ResolvedSite {
  return {
    ...entry,
    profiles: [entry.default_profile ?? 'production'],
    protocol: 'ftps',
    credentialsStatus: 'present',
    lastPushAt: '2026-07-01T12:00:00.000Z',
    health: 'ok',
    ...overrides,
  };
}

describe('registerSitesCommand', () => {
  let entries: SiteEntry[];
  let stdout: string[];
  let stderr: string[];
  let registry: SiteRegistrySurface;
  let resolveSite: ReturnType<typeof vi.fn<(entry: SiteEntry) => Promise<ResolvedSite>>>;
  let runDoctor: ReturnType<
    typeof vi.fn<(context: { cwd: string; profile: string }) => Promise<DoctorReport>>
  >;

  beforeEach(() => {
    entries = [];
    stdout = [];
    stderr = [];
    registry = {
      list: vi.fn(async () => [...entries]),
      add: vi.fn(async (entry: SiteEntry) => {
        if (entries.some(({ name }) => name === entry.name)) {
          throw new SiteRegistryDuplicateError(entry.name);
        }
        entries = [...entries, entry];
        return [...entries];
      }),
      remove: vi.fn(async (name: string) => {
        entries = entries.filter((entry) => entry.name !== name);
        return [...entries];
      }),
    };
    resolveSite = vi.fn(async (entry) => resolved(entry));
    runDoctor = vi.fn(async () => passingDoctorReport);
  });

  async function parse(args: string[], overrides: Partial<SitesCommandDeps> = {}): Promise<void> {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => stdout.push(text.trimEnd()),
      writeErr: (text) => stderr.push(text.trimEnd()),
    });
    registerSitesCommand(program, {
      cwd: '/work/current-site',
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      keychain: { hasPassword: async () => false },
      createRegistry: () => registry,
      resolveSite,
      runDoctor,
      ...overrides,
    });
    await program.parseAsync(['node', 'aiftp', ...args], { from: 'node' });
  }

  it('prints a friendly message for an empty registry', async () => {
    await parse(['sites']);

    expect(stdout).toContain('No sites registered.');
  });

  it('lists two resolved sites as a table for both list forms', async () => {
    entries = [
      { name: 'alpha', path: '/sites/alpha', label: 'Alpha', default_profile: 'staging' },
      { name: 'beta', path: '/sites/beta', label: 'Beta' },
    ];
    resolveSite.mockImplementation(async (entry) =>
      entry.name === 'alpha'
        ? resolved(entry, { protocol: 'sftp', credentialsStatus: 'missing', health: 'invalid' })
        : resolved(entry, { lastPushAt: undefined }),
    );

    await parse(['sites', 'list']);

    expect(stdout[0]).toMatch(/NAME\s+LABEL\s+DEFAULT_PROFILE\s+PROTOCOL\s+CREDENTIALS/);
    expect(stdout.join('\n')).toContain('alpha');
    expect(stdout.join('\n')).toContain('Alpha');
    expect(stdout.join('\n')).toContain('sftp');
    expect(stdout.join('\n')).toContain('missing');
    expect(stdout.join('\n')).toContain('invalid');
    expect(stdout.join('\n')).toContain('beta');
    expect(stdout.join('\n')).toContain('-');
  });

  it('emits the resolved site array as JSON', async () => {
    entries = [{ name: 'alpha', path: '/sites/alpha' }];

    await parse(['sites', '--json']);

    expect(JSON.parse(stdout[0] ?? '')).toEqual([resolved(entries[0] as SiteEntry)]);
  });

  it('adds an explicit path with name, label, and default profile', async () => {
    await parse([
      'sites',
      'add',
      '/sites/alpha',
      '--name',
      'alpha-prod',
      '--label',
      'Alpha',
      '--default-profile',
      'staging',
    ]);

    expect(registry.add).toHaveBeenCalledWith({
      name: 'alpha-prod',
      path: '/sites/alpha',
      label: 'Alpha',
      default_profile: 'staging',
    });
    expect(stdout).toContain('Registered site alpha-prod at /sites/alpha.');
  });

  it('defaults add path to cwd and name to the directory basename', async () => {
    await parse(['sites', 'add']);

    expect(registry.add).toHaveBeenCalledWith({
      name: basename('/work/current-site'),
      path: '/work/current-site',
    });
  });

  it('reports duplicate names to stderr and throws CommanderError', async () => {
    entries = [{ name: 'alpha', path: '/sites/old-alpha' }];

    const result = parse(['sites', 'add', '/sites/alpha', '--name', 'alpha']);

    await expect(result).rejects.toMatchObject<Partial<CommanderError>>({
      name: 'CommanderError',
      exitCode: 1,
      code: 'aiftp.sites-duplicate',
    });
    expect(stderr).toContain("Site 'alpha' is already registered");
  });

  it('removes an existing site and prints confirmation', async () => {
    entries = [{ name: 'alpha', path: '/sites/alpha' }];

    await parse(['sites', 'remove', 'alpha']);

    expect(registry.remove).toHaveBeenCalledWith('alpha');
    expect(stdout).toContain('Removed site alpha.');
  });

  it('handles removing an absent site without throwing', async () => {
    await parse(['sites', 'remove', 'absent']);

    expect(stdout).toContain('Site absent was not registered.');
  });

  it('doctor reports config and credential status without connecting by default', async () => {
    entries = [
      { name: 'alpha', path: '/sites/alpha' },
      { name: 'beta', path: '/sites/beta' },
    ];
    resolveSite.mockImplementation(async (entry) =>
      entry.name === 'alpha'
        ? resolved(entry)
        : resolved(entry, { health: 'missing', credentialsStatus: 'missing' }),
    );

    await parse(['sites', 'doctor']);

    expect(runDoctor).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('alpha: ok');
    expect(stdout.join('\n')).toContain('beta: fail');
    expect(stdout.join('\n')).toContain('credentials=missing');
    expect(stdout.join('\n')).toContain('summary: pass=1 warn=0 fail=1');
  });

  it('doctor --connect runs and aggregates one connection check per site', async () => {
    entries = [
      {
        name: 'alpha',
        path: join('/sites', 'alpha'),
        default_profile: 'staging',
      },
      { name: 'beta', path: join('/sites', 'beta') },
    ];
    runDoctor.mockResolvedValueOnce(passingDoctorReport).mockResolvedValueOnce({
      ok: false,
      results: [],
      summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
    });

    await parse(['sites', 'doctor', '--connect']);

    expect(runDoctor).toHaveBeenNthCalledWith(1, { cwd: '/sites/alpha', profile: 'staging' });
    expect(runDoctor).toHaveBeenNthCalledWith(2, { cwd: '/sites/beta', profile: 'production' });
    expect(stdout.join('\n')).toContain('alpha: pass');
    expect(stdout.join('\n')).toContain('beta: fail');
    expect(stdout.join('\n')).toContain('summary: pass=1 warn=0 fail=1');
  });
});
