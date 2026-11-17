/*
 * Shared rules for the secrets an agent asks the person for (agent secret
 * requests): the name shape every host validates and the value limits the
 * request form, the stores and the redactor agree on. Environment-neutral,
 * so desktop, web and the core daemon all import the same rules.
 */

/**
 * A secret's name: shaped like an environment variable, because it is both
 * the handle the agent uses and, by default, the variable a command gets.
 */
export const AGENT_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** True when `name` is a valid secret name. */
export function isAgentSecretName(name: string): boolean {
  return AGENT_SECRET_NAME_PATTERN.test(name);
}

/** The longest value a person can provide for one secret. */
export const AGENT_SECRET_VALUE_MAX_LENGTH = 16_384;

/**
 * The shortest value output redaction matches. Shorter values are still
 * accepted, but the form warns that redaction may miss them.
 */
export const AGENT_SECRET_REDACTION_MIN_LENGTH = 4;

/**
 * Below this length the request form warns that output redaction may miss
 * the value: short values are likelier to match ordinary text and to be
 * altered on output.
 */
export const AGENT_SECRET_SHORT_VALUE_WARNING_LENGTH = 8;
