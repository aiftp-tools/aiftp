import type { FlowResult, PromptField } from './types.ts';

/**
 * Minimal abstraction over the `prompts` library so PromptFlow can be
 * driven by a vitest mock in tests without coupling to the runtime CLI.
 */
export type PromptFn = (question: unknown) => Promise<Record<string, unknown>>;

export interface PromptFlowDeps {
  prompt: PromptFn;
  stderr: (msg: string) => void;
}

/**
 * v0.11 init UX framework — ordered prompt runner with hint display (A)
 * and `:back` navigation (B) added in subsequent commits.
 *
 * This commit ships the minimal skeleton: iterate `fields` in order,
 * pass each one to the prompt function, and accumulate the answers.
 */
export class PromptFlow {
  constructor(
    private readonly fields: ReadonlyArray<PromptField>,
    private readonly deps: PromptFlowDeps,
  ) {}

  async run(): Promise<FlowResult> {
    const answers: Record<string, unknown> = {};
    for (const field of this.fields) {
      this.printHint(field);
      const raw = await this.deps.prompt({
        name: field.name,
        type: field.type,
        message: field.label,
      });
      answers[field.name] = raw[field.name];
    }
    return { kind: 'completed', answers };
  }

  /**
   * A (input hint): print field-specific guidance to stderr before each prompt.
   * Helps the user pick a sensible value *before* having to commit to one,
   * upgrading v0.10.3's post-hoc port confirmation into a pre-prompt nudge.
   */
  private printHint(field: PromptField): void {
    if (field.hint) this.deps.stderr(`  💡 ${field.hint}`);
    if (field.example) this.deps.stderr(`  例: ${field.example}`);
  }
}
