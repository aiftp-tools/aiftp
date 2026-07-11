import { basename, resolve } from 'node:path';
import {
  type DoctorReport,
  type ResolvedSite,
  type SiteEntry,
  SiteRegistry,
  SiteRegistryDuplicateError,
  resolveSite as resolveSiteFromCore,
} from '@aiftp-tools/core';
import { type Command, CommanderError } from 'commander';

export interface SiteRegistrySurface {
  list(): Promise<readonly SiteEntry[]>;
  add(entry: SiteEntry): Promise<readonly SiteEntry[]>;
  remove(name: string): Promise<readonly SiteEntry[]>;
}

interface SitesKeychain {
  hasPassword(service: string, account: string): Promise<boolean>;
}

interface SitesDoctorContext {
  cwd: string;
  profile: string;
}

export interface SitesCommandDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly keychain: SitesKeychain;
  readonly createRegistry?: () => SiteRegistrySurface;
  readonly resolveSite?: (entry: SiteEntry) => Promise<ResolvedSite>;
  readonly runDoctor: (context: SitesDoctorContext) => Promise<DoctorReport>;
}

interface AddOptions {
  name?: string;
  label?: string;
  defaultProfile?: string;
}

interface ListOptions {
  json?: boolean;
}

interface DoctorOptions {
  connect?: boolean;
}

function text(value: string | undefined): string {
  return value ?? '-';
}

function printSitesTable(stdout: (line: string) => void, sites: readonly ResolvedSite[]): void {
  if (sites.length === 0) {
    stdout('No sites registered.');
    return;
  }

  const rows = sites.map((site) => [
    site.name,
    text(site.label),
    text(site.default_profile),
    text(site.protocol),
    site.credentialsStatus,
    text(site.lastPushAt),
    site.health,
  ]);
  const headers = [
    'NAME',
    'LABEL',
    'DEFAULT_PROFILE',
    'PROTOCOL',
    'CREDENTIALS',
    'LAST_PUSH',
    'HEALTH',
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join('  ')
      .trimEnd();

  stdout(format(headers));
  for (const row of rows) stdout(format(row));
}

function siteStatus(site: ResolvedSite): 'pass' | 'warn' | 'fail' {
  if (site.health !== 'ok') return 'fail';
  if (site.credentialsStatus === 'missing') return 'warn';
  return 'pass';
}

export function registerSitesCommand(program: Command, deps: SitesCommandDeps): void {
  const registry = deps.createRegistry?.() ?? new SiteRegistry();
  const resolveSite =
    deps.resolveSite ??
    ((entry: SiteEntry) =>
      resolveSiteFromCore(entry, {
        hasPassword: (service, account) => deps.keychain.hasPassword(service, account),
      }));

  const list = async (options: ListOptions): Promise<void> => {
    const sites = await Promise.all((await registry.list()).map((entry) => resolveSite(entry)));
    if (options.json) {
      deps.stdout(JSON.stringify(sites));
      return;
    }
    printSitesTable(deps.stdout, sites);
  };

  const sites = program
    .command('sites')
    .description('Manage registered aiftp sites')
    .option('--json', 'emit resolved sites as JSON')
    .action(async (options: ListOptions) => list(options));

  sites
    .command('list')
    .description('List registered sites')
    .option('--json', 'emit resolved sites as JSON')
    .action(async (options: ListOptions, command: Command) =>
      list({ json: options.json ?? command.parent?.opts<ListOptions>().json }),
    );

  sites
    .command('add [path]')
    .description('Register an aiftp site')
    .option('--name <name>', 'site name')
    .option('--label <label>', 'display label')
    .option('--default-profile <profile>', 'default profile')
    .action(async (path: string | undefined, options: AddOptions) => {
      const sitePath = resolve(deps.cwd, path ?? '.');
      const entry: SiteEntry = {
        name: options.name ?? basename(sitePath),
        path: sitePath,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.defaultProfile === undefined
          ? {}
          : { default_profile: options.defaultProfile }),
      };
      try {
        await registry.add(entry);
      } catch (error: unknown) {
        if (error instanceof SiteRegistryDuplicateError) {
          deps.stderr(error.message);
          throw new CommanderError(1, 'aiftp.sites-duplicate', error.message);
        }
        throw error;
      }
      deps.stdout(`Registered site ${entry.name} at ${entry.path}.`);
    });

  sites
    .command('remove <name>')
    .description('Remove a registered site')
    .action(async (name: string) => {
      const existed = (await registry.list()).some((entry) => entry.name === name);
      await registry.remove(name);
      deps.stdout(existed ? `Removed site ${name}.` : `Site ${name} was not registered.`);
    });

  sites
    .command('doctor')
    .description('Check all registered site configurations')
    .option('--connect', 'also run live connection checks')
    .action(async (options: DoctorOptions) => {
      const entries = await registry.list();
      const resolvedSites = await Promise.all(entries.map((entry) => resolveSite(entry)));
      let pass = 0;
      let warn = 0;
      let fail = 0;

      for (const site of resolvedSites) {
        const configStatus = siteStatus(site);
        if (!options.connect) {
          if (configStatus === 'pass') pass += 1;
          if (configStatus === 'warn') warn += 1;
          if (configStatus === 'fail') fail += 1;
          const displayStatus = configStatus === 'pass' ? 'ok' : configStatus;
          deps.stdout(
            `${site.name}: ${displayStatus} health=${site.health} credentials=${site.credentialsStatus}`,
          );
          continue;
        }

        const report = await deps.runDoctor({
          cwd: site.path,
          profile: site.default_profile ?? 'production',
        });
        const combinedStatus = !report.ok || configStatus === 'fail' ? 'fail' : configStatus;
        if (combinedStatus === 'pass') pass += 1;
        if (combinedStatus === 'warn') warn += 1;
        if (combinedStatus === 'fail') fail += 1;
        deps.stdout(
          `${site.name}: ${combinedStatus} health=${site.health} credentials=${site.credentialsStatus} connect=${report.ok ? 'pass' : 'fail'}`,
        );
      }

      deps.stdout(`summary: pass=${pass} warn=${warn} fail=${fail}`);
    });
}
