import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_SCHEMA = 1;
const STATE_FILE = 'state.json';

export interface StateFileEntry {
  hash: string;
  size: number;
  updatedAt: string;
}

export interface State {
  schema: typeof STATE_SCHEMA;
  files: Record<string, StateFileEntry>;
}

export class StateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StateError';
  }
}

function emptyState(): State {
  return {
    schema: STATE_SCHEMA,
    files: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateEntry(path: string, value: unknown): StateFileEntry {
  if (!isRecord(value)) {
    throw new StateError(`Invalid state entry for '${path}': expected object`);
  }
  if (typeof value.hash !== 'string' || value.hash.length === 0) {
    throw new StateError(`Invalid state entry for '${path}': hash must be a non-empty string`);
  }
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new StateError(`Invalid state entry for '${path}': size must be a non-negative integer`);
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new StateError(`Invalid state entry for '${path}': updatedAt must be an ISO date string`);
  }

  return {
    hash: value.hash,
    size: value.size,
    updatedAt: value.updatedAt,
  };
}

function validateState(value: unknown): State {
  if (!isRecord(value)) {
    throw new StateError('Invalid state: expected object');
  }
  if (value.schema !== STATE_SCHEMA) {
    throw new StateError(`Unsupported state schema: ${String(value.schema)}`);
  }
  if (!isRecord(value.files)) {
    throw new StateError('Invalid state: files must be an object');
  }

  const files = Object.fromEntries(
    Object.entries(value.files).map(([path, entry]) => [path, validateEntry(path, entry)]),
  );

  return {
    schema: STATE_SCHEMA,
    files,
  };
}

function statePath(profileDir: string): string {
  return join(profileDir, STATE_FILE);
}

function normalizeStatePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, '');
}

export async function computeHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function loadState(profileDir: string): Promise<State> {
  let source: string;
  try {
    source = await readFile(statePath(profileDir), 'utf8');
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      typeof error.code === 'string' &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return emptyState();
    }
    throw new StateError(`Failed to read state at ${statePath(profileDir)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new StateError(`Failed to parse state at ${statePath(profileDir)}`, { cause: error });
  }

  return validateState(parsed);
}

export async function saveState(profileDir: string, state: State): Promise<void> {
  const validated = validateState(state);
  await mkdir(profileDir, { recursive: true });

  const target = statePath(profileDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

export function updateFileEntry(
  state: State,
  path: string,
  hash: string,
  size: number,
  options: { updatedAt?: string } = {},
): State {
  const normalizedPath = normalizeStatePath(path);
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const next = {
    schema: STATE_SCHEMA,
    files: {
      ...state.files,
      [normalizedPath]: {
        hash,
        size,
        updatedAt,
      },
    },
  };

  return validateState(next);
}

export function removeFileEntry(state: State, path: string): State {
  const normalizedPath = normalizeStatePath(path);
  const { [normalizedPath]: _removed, ...files } = state.files;
  return validateState({
    schema: STATE_SCHEMA,
    files,
  });
}
