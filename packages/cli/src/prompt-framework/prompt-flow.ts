import { BACK_KEYWORD, type FlowResult, type PromptField } from './types.ts';

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
    let cursor = 0;
    while (cursor < this.fields.length) {
      const field = this.fields[cursor];
      this.printHint(field);
      const raw = await this.deps.prompt({
        name: field.name,
        type: field.type,
        message: field.label,
      });
      const value = raw[field.name];

      // Cancel signal — `prompts` returns null or omits the key when the
      // user hits Ctrl+C / EOF (after our defaultPrompt's onCancel hook
      // suppresses the auto-exit). Either shape means cancel.
      if (value === null || value === undefined) return { kind: 'cancelled' };

      // B (戻りナビ) — reserved ASCII `:back` keyword. Checked BEFORE
      // sanitize so a field-level `sanitize` cannot accidentally swallow
      // the navigation signal. Full-width `：ｂａｃｋ` is intentionally
      // *not* treated as back — it falls through to normal storage.
      if (value === BACK_KEYWORD) {
        if (cursor === 0) {
          this.deps.stderr('  ↩ もう戻れません（1問目です）');
        } else {
          // Drop the answer recorded for the field we are stepping back
          // *into*, so the user re-enters it on the next prompt.
          delete answers[this.fields[cursor - 1].name];
          cursor--;
        }
        continue;
      }

      answers[field.name] = value;
      cursor++;
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
