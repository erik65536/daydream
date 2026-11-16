/**
 * The rules for what people type to make and keep an account: a user name (to sign in), the name others see, and a
 * password. The server enforces them and the account screens explain them as you type, from this one definition.
 *
 * A user name is typed at every sign-in, so it is kept to characters that are easy to type and hard to get wrong:
 * letters, numbers, dots, dashes, and underscores. Spaces at its ends are dropped; a space inside it is refused with
 * a suggestion, since the name others see is where spaces belong. Case does not matter (the database compares user
 * names without it), so "Ada" and "ada" are the same account.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const DISPLAY_NAME_MAX = 32;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/** What was typed, cleaned up, and what is wrong with it if anything. */
export interface Check {
  value: string;
  problem?: string;
  /** The problem may only mean it is not finished (empty or too short), so a screen can wait until the field is left. */
  unfinished?: boolean;
}

const USERNAME_CHAR = /[A-Za-z0-9._-]/;

export function checkUsername(typed: string): Check {
  const value = typed.trim();
  const bad = [...value].find((c) => !USERNAME_CHAR.test(c));
  if (bad !== undefined)
    return { value, problem: /\s/.test(bad) ? 'User names cannot have spaces. Try a dot, dash, or underscore instead.' : `User names cannot have "${bad}". Use letters, numbers, dots, dashes, or underscores.` };
  if (!value) return { value, problem: 'Choose a user name.', unfinished: true };
  if (value.length < USERNAME_MIN) return { value, problem: `User names need at least ${USERNAME_MIN} characters.`, unfinished: true };
  if (value.length > USERNAME_MAX) return { value, problem: `User names can have at most ${USERNAME_MAX} characters.` };
  return { value };
}

/** The name others see: any characters, with runs of spaces made one. */
export function checkDisplayName(typed: string): Check {
  const value = typed.trim().replace(/\s+/g, ' ');
  if (!value) return { value, problem: 'Choose the name other players see.', unfinished: true };
  if (value.length > DISPLAY_NAME_MAX) return { value, problem: `Names can have at most ${DISPLAY_NAME_MAX} characters.` };
  return { value };
}

/** A password is kept exactly as typed. */
export function checkPassword(typed: string): Check {
  if (typed.length < PASSWORD_MIN) return { value: typed, problem: `Passwords need at least ${PASSWORD_MIN} characters.`, unfinished: true };
  if (typed.length > PASSWORD_MAX) return { value: typed, problem: `Passwords can have at most ${PASSWORD_MAX} characters.` };
  return { value: typed };
}
