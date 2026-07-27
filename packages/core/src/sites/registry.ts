import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { z } from 'zod';
import type { SiteEntry } from './types.js';

export const SITE_REGISTRY_SCHEMA_VERSION = 1 as const;

/**
 * v0.12.4 (LOW-1): site names are an allowlist, not "any non-empty string".
 * `aiftp init --from <x>` resolves a registered site name BEFORE trying `x`
 * as a filesystem path, so a hand-edited registry entry named like a path
 * (`../prod`, `client/a`) silently shadows the operator's intended argument
 * and redirects config inheritance. Path separators, `:`, control
 * characters, and bare `.` / `..` are all rejected.
 */
const SITE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

const siteNameSchema = z
  .string()
  .min(1, 'name must not be empty')
  .regex(
    SITE_NAME_PATTERN,
    'name must contain only letters, digits, dot, underscore, or hyphen (no path separators or control characters)',
  )
  .refine((name) => name !== '.' && name !== '..', 'name must not be a path reference');

/**
 * Registry paths must be absolute and free of traversal segments. `sites add`
 * writes them through `resolve()`, so well-formed registries round-trip
 * unchanged; this only rejects hand-edited relative or traversal-shaped
 * values.
 *
 * Deliberately NOT `normalize(value) === value`: on Windows `normalize()`
 * rewrites `/projects/site` to `\projects\site`, so exact-match would reject
 * perfectly valid slash-written absolute paths. Splitting on both separators
 * targets the actual threat (`.` / `..` segments) and behaves the same on
 * every platform.
 */
const sitePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .refine((value) => isAbsolute(value), 'path must be absolute')
  .refine(
    (value) => !value.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..'),
    'path must not contain "." or ".." segments',
  );

export const siteEntrySchema = z
  .object({
    name: siteNameSchema,
    path: sitePathSchema,
    label: z.string().min(1, 'label must not be empty').optional(),
    default_profile: z.string().min(1, 'default_profile must not be empty').optional(),
  })
  .strict();

const sitePointerSchema = siteEntrySchema.omit({ name: true });

export const siteRegistrySchema = z
  .object({
    schema_version: z.literal(SITE_REGISTRY_SCHEMA_VERSION),
    sites: z.record(siteNameSchema, sitePointerSchema).default({}),
  })
  .strict();

export interface SiteRegistryReadResult {
  readonly entries: readonly SiteEntry[];
  readonly warning?: string;
}

export class SiteRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SiteRegistryError';
  }
}

export class SiteRegistryValidationError extends SiteRegistryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SiteRegistryValidationError';
  }
}

export class SiteRegistryDuplicateError extends SiteRegistryError {
  constructor(name: string) {
    super(`Site '${name}' is already registered`);
    this.name = 'SiteRegistryDuplicateError';
  }
}

function registryPath(): string {
  return join(homedir(), '.aiftp', 'sites.toml');
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function warning(message: string): SiteRegistryReadResult {
  return { entries: [], warning: message };
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function validateEntries(entries: readonly SiteEntry[]): readonly SiteEntry[] {
  const parsedEntries = entries.map((entry) => {
    const result = siteEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new SiteRegistryValidationError(
        `Invalid site registry entry: ${validationMessage(result.error)}`,
        { cause: result.error },
      );
    }
    return result.data;
  });

  const names = new Set<string>();
  for (const entry of parsedEntries) {
    if (names.has(entry.name)) {
      throw new SiteRegistryValidationError(
        `Invalid site registry entries: duplicate name '${entry.name}'`,
      );
    }
    names.add(entry.name);
  }
  return parsedEntries;
}

function toRegistryDocument(entries: readonly SiteEntry[]): z.infer<typeof siteRegistrySchema> {
  return {
    schema_version: SITE_REGISTRY_SCHEMA_VERSION,
    sites: Object.fromEntries(
      entries.map(({ name, path, label, default_profile }) => [
        name,
        {
          path,
          ...(label === undefined ? {} : { label }),
          ...(default_profile === undefined ? {} : { default_profile }),
        },
      ]),
    ),
  };
}

function fromRegistryDocument(document: z.infer<typeof siteRegistrySchema>): readonly SiteEntry[] {
  return Object.entries(document.sites).map(([name, pointer]) => ({ name, ...pointer }));
}

export class SiteRegistry {
  async read(): Promise<SiteRegistryReadResult> {
    const path = registryPath();
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isFileNotFound(error)) {
        return { entries: [] };
      }
      const message = error instanceof Error ? error.message : String(error);
      return warning(`Failed to read site registry at ${path}: ${message}`);
    }

    let parsed: unknown;
    try {
      parsed = parseToml(source);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return warning(`Failed to parse site registry at ${path}: ${message}`);
    }

    const result = siteRegistrySchema.safeParse(parsed);
    if (!result.success) {
      return warning(
        `Failed to validate site registry at ${path}: ${validationMessage(result.error)}`,
      );
    }
    return { entries: fromRegistryDocument(result.data) };
  }

  async write(entries: readonly SiteEntry[]): Promise<void> {
    const validatedEntries = validateEntries(entries);
    const document = toRegistryDocument(validatedEntries);
    const path = registryPath();
    const directory = dirname(path);
    const temporaryPath = join(directory, `.sites.toml.tmp-${process.pid}-${randomUUID()}`);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, stringifyToml(document), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error: unknown) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new SiteRegistryError(`Failed to write site registry at ${path}`, { cause: error });
    }
  }

  async add(entry: SiteEntry): Promise<readonly SiteEntry[]> {
    const [validatedEntry] = validateEntries([entry]);
    if (validatedEntry === undefined) {
      throw new SiteRegistryValidationError('Invalid empty site registry entry');
    }
    const current = await this.readForMutation();
    if (current.some(({ name }) => name === validatedEntry.name)) {
      throw new SiteRegistryDuplicateError(validatedEntry.name);
    }
    const next = [...current, validatedEntry];
    await this.write(next);
    return next;
  }

  async remove(name: string): Promise<readonly SiteEntry[]> {
    const nameResult = siteEntrySchema.shape.name.safeParse(name);
    if (!nameResult.success) {
      throw new SiteRegistryValidationError(
        `Invalid site name: ${validationMessage(nameResult.error)}`,
        { cause: nameResult.error },
      );
    }
    const current = await this.readForMutation();
    const next = current.filter((entry) => entry.name !== nameResult.data);
    if (next.length !== current.length) {
      await this.write(next);
    }
    return next;
  }

  async list(): Promise<readonly SiteEntry[]> {
    return (await this.read()).entries;
  }

  private async readForMutation(): Promise<readonly SiteEntry[]> {
    const result = await this.read();
    if (result.warning !== undefined) {
      throw new SiteRegistryError(
        `Refusing to overwrite an unreadable site registry: ${result.warning}`,
      );
    }
    return result.entries;
  }
}
