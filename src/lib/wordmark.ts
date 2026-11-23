/**
 * The hanna.fm wordmark as text art: a five-row pixel face drawn with full-block characters.
 * The name and the suffix are separate so the suffix can take the accent colour.
 * Every row of one part has the same width.
 */
export const WORDMARK_HEIGHT = 5;

export const WORDMARK_NAME: readonly string[] = [
  "█     ██  ███  ███   ██ ",
  "█    █  █ █  █ █  █ █  █",
  "███  ████ █  █ █  █ ████",
  "█  █ █  █ █  █ █  █ █  █",
  "█  █ █  █ █  █ █  █ █  █",
];

export const WORDMARK_SUFFIX: readonly string[] = [
  "    ██ ████ ",
  "   █   █ █ █",
  "   ███ █ █ █",
  "   █   █ █ █",
  " █ █   █ █ █",
];
