import { BACK_KEYWORD, type FlowResult, type PromptField } from './types.js';

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

  /** Hard cap on total prompt iterations — guards against pathological
   * validate functions or back-loop oscillation. 100 is generous: a
   * fresh init has 9 fields, so a user could re-enter every field 10×. */
  private static readonly MAX_ITERATIONS = 100;

  async run(): Promise<FlowResult> {
    const answers: Record<string, unknown> = {};
    let cursor = 0;
    let iterations = 0;
    // S1 (Phase 1 review): track the cursor that last received a hint
    // print so that validate re-prompt loops don't spam the hint again.
    // When the cursor moves (advance or :back) the next arrival is fresh
    // and the hint prints once more.
    let lastHintedCursor = -1;
    while (cursor < this.fields.length) {
      if (++iterations > PromptFlow.MAX_ITERATIONS) {
        this.deps.stderr(`  ✗ 入力 ${PromptFlow.MAX_ITERATIONS} 回を超えました — 強制終了します`);
        return { kind: 'cancelled' };
      }
      const field = this.fields[cursor];
      if (!field) break; // unreachable — while condition guards this, but TS strict-mode needs it.
      if (cursor !== lastHintedCursor) {
        this.printHint(field);
        lastHintedCursor = cursor;
      }
      const raw = await this.deps.prompt(this.buildQuestion(field, answers));
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
          const previousField = this.fields[cursor - 1];
          if (previousField) delete answers[previousField.name];
          cursor--;
        }
        continue;
      }

      const sanitized = field.sanitize ? field.sanitize(value) : value;

      if (field.validate) {
        const verdict = field.validate(sanitized as never, answers);
        if (verdict !== true) {
          this.deps.stderr(`  ✗ ${verdict}`);
          continue;
        }
      }

      answers[field.name] = sanitized;
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

  /**
   * Build the `prompts` library question object for a field, forwarding
   * select choices, number bounds, and the (possibly answer-dependent)
   * initial value.
   */
  private buildQuestion(
    field: PromptField,
    answers: Record<string, unknown>,
  ): Record<string, unknown> {
    const question: Record<string, unknown> = {
      name: field.name,
      type: field.type,
      message: field.label,
    };
    if (field.choices) question.choices = field.choices;
    if (field.min !== undefined) question.min = field.min;
    if (field.max !== undefined) question.max = field.max;
    if (field.initial !== undefined) {
      question.initial =
        typeof field.initial === 'function'
          ? (field.initial as (a: Record<string, unknown>) => unknown)(answers)
          : field.initial;
    }
    return question;
  }
}
