/**
 * v0.11 init UX framework — PromptField type definitions.
 *
 * Designed to support the "三重防御" model:
 * - A: hint / example displayed before each prompt
 * - B: `:back` keyword to navigate to the previous field
 * - C: summary review with edit loop (already in v0.10.4, lives outside this framework)
 */

export type PromptFieldType = 'text' | 'password' | 'number' | 'select' | 'confirm';

export interface PromptFieldChoice {
  title: string;
  value: string;
  description?: string;
}

export interface PromptField<T = unknown> {
  /** Field identifier — becomes the key in the answers record. */
  name: string;
  /** User-facing question label shown by the prompt. */
  label: string;
  /** Matches the `prompts` library type. */
  type: PromptFieldType;
  /** A: explanatory hint printed to stderr before the prompt. */
  hint?: string;
  /** A: concrete example (e.g. `"21 (FTP), 990 (FTPS)"`). */
  example?: string;
  /** Returns `true` on success, or an error message string to display and re-prompt. */
  validate?: (value: T, answers: Record<string, unknown>) => true | string;
  /** Converts the raw prompt output (trim, control-char reject, parseInt, …). */
  sanitize?: (raw: unknown) => T;
  /** Initial value for the prompt — may depend on prior answers. */
  initial?: T | ((answers: Record<string, unknown>) => T);
  /** `select` type only. */
  choices?: PromptFieldChoice[];
  /** `number` type bounds — propagated to the prompts library. */
  min?: number;
  max?: number;
}

export type PromptResult<T> = { kind: 'value'; value: T } | { kind: 'back' } | { kind: 'cancel' };

export type FlowResult =
  | { kind: 'completed'; answers: Record<string, unknown> }
  | { kind: 'cancelled' };

/** Reserved keyword for B (戻りナビ). */
export const BACK_KEYWORD = ':back';
