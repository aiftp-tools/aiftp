import { createCli } from '@aiftp-tools/cli';
import {
  type BootstrapInput,
  type BootstrapResult,
  runBootstrap as realRunBootstrap,
} from '@aiftp-tools/core';

export interface DesktopServerDeps {
  readonly startMcp?: (options: { cwd: string }) => Promise<void>;
  readonly runBootstrap?: (input: Partial<BootstrapInput>) => Promise<BootstrapResult>;
}

export interface DesktopStartupReport {
  readonly bootstrap?: BootstrapResult;
  readonly error?: { readonly message: string; readonly hint: string };
}

const GENERIC_HINT =
  'Claude Desktop の設定 → 拡張機能 → aiftp の各項目を確認し、Claude Desktop を再起動してください。';

function text(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function readDesktopEnv(env: NodeJS.ProcessEnv): Partial<BootstrapInput> {
  const fields: Array<[keyof BootstrapInput, string | undefined]> = [
    ['localRoot', text(env.AIFTP_PROJECT_DIR)],
    ['siteName', text(env.AIFTP_BOOTSTRAP_SITE)],
    ['host', text(env.AIFTP_BOOTSTRAP_HOST)],
    ['protocol', text(env.AIFTP_BOOTSTRAP_PROTOCOL)],
    ['username', text(env.AIFTP_BOOTSTRAP_USER)],
    ['remoteRoot', text(env.AIFTP_BOOTSTRAP_REMOTE_ROOT)],
    ['credential', text(env.AIFTP_BOOTSTRAP_CREDENTIAL)],
    ['profileName', text(env.AIFTP_BOOTSTRAP_PROFILE) ?? 'production'],
  ];
  const input: Record<string, unknown> = {};
  for (const [key, value] of fields) {
    if (value !== undefined) input[key] = value;
  }
  return input as Partial<BootstrapInput>;
}

/**
 * Design rule (spec §5.1): the server MUST always start. Claude Desktop shows
 * a bare "connection error" when the process exits, which is invisible to a
 * trainee and to the instructor. Every configuration problem is therefore
 * captured here and surfaced later through `aiftp_setup_status`.
 */
export async function startDesktopServer(
  env: NodeJS.ProcessEnv,
  deps: DesktopServerDeps = {},
): Promise<DesktopStartupReport> {
  const bootstrapFn =
    deps.runBootstrap ?? ((input: Partial<BootstrapInput>) => realRunBootstrap(input));
  const startMcp =
    deps.startMcp ??
    (async ({ cwd }: { cwd: string }) => {
      // Reuse the CLI's `mcp` command so the server gets the same runDoctor
      // wiring the terminal path has. Without it `aiftp_profile_test` refuses
      // every call (packages/mcp/src/index.ts handleProfileTest).
      // stdout/stderr are silenced because stdio is the MCP transport.
      await createCli({ cwd, stdout: () => {}, stderr: () => {} }).parseAsync([
        'node',
        'aiftp',
        'mcp',
      ]);
    });

  const input = readDesktopEnv(env);
  let report: DesktopStartupReport = {};
  try {
    report = { bootstrap: await bootstrapFn(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint =
      typeof (error as { hint?: unknown }).hint === 'string'
        ? (error as { hint: string }).hint
        : GENERIC_HINT;
    report = { error: { message, hint } };
  }

  process.env.AIFTP_DESKTOP_STARTUP = JSON.stringify(report);
  await startMcp({ cwd: input.localRoot ?? process.cwd() });
  return report;
}
