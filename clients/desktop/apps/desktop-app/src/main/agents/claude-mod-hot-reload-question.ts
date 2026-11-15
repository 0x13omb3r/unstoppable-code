import type {
  McpQuestion,
  McpQuestionAnswer,
} from '@canopy/desktop-shared/types';

/** The option Claude Code 2.1.319 offers to turn the session's Mods on. */
export const CLAUDE_MOD_HOT_RELOAD_ACCEPT = 'Turn them on';

// Bumped inside each write that takes consent from a session-written Mod (a
// Disallow of one, the kill switch turned on), so a "Turn them on" answered
// before it cannot write that consent back.
let claudeModConsentEpoch = 0;

/** Read when the person answers; consent recorded later must still match it. */
export function currentClaudeModConsentEpoch(): number {
  return claudeModConsentEpoch;
}

export function bumpClaudeModConsentEpoch(): void {
  claudeModConsentEpoch += 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude's own question about the Mods it writes in a session: a forced
 * `AskUserQuestion` with a `confirm_` id and `metadata.source:
 * "mod_hot_reload"`. Only the person answers it, never the approval service.
 */
export function isClaudeModHotReloadQuestion(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string | undefined,
): boolean {
  return (
    toolName === 'AskUserQuestion' &&
    toolUseID?.startsWith('confirm_') === true &&
    isRecord(input.metadata) &&
    input.metadata.source === 'mod_hot_reload'
  );
}

/** The question as Canopy's chat question card shows it: the options only. */
export function claudeModHotReloadQuestions(
  input: Record<string, unknown>,
): McpQuestion[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((question): McpQuestion[] => {
    if (!isRecord(question) || typeof question.question !== 'string') {
      return [];
    }
    const options = (Array.isArray(question.options) ? question.options : [])
      .filter(isRecord)
      .filter((option) => typeof option.label === 'string');
    const descriptions = options.map((option) =>
      typeof option.description === 'string' ? option.description : '',
    );
    return [
      {
        question: question.question,
        ...(typeof question.header === 'string'
          ? { header: question.header }
          : {}),
        options: options.map((option) => String(option.label)),
        ...(descriptions.some(Boolean)
          ? { optionDescriptions: descriptions }
          : {}),
        multiSelect: question.multiSelect === true,
        allowOther: false,
      },
    ];
  });
}

/** Claude's input with the person's picks, the shape it counts as answered. */
export function withClaudeModHotReloadAnswers(
  input: Record<string, unknown>,
  answers: readonly McpQuestionAnswer[],
): Record<string, unknown> {
  return {
    ...input,
    answers: Object.fromEntries(
      answers.map((answer) => [
        answer.question,
        answer.selectedOptions.join(', '),
      ]),
    ),
  };
}
