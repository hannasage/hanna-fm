/**
 * The hanna.fm wordmark as text art: three rows of half-block characters.
 * The name and the suffix are separate so the suffix can take the accent colour.
 * The suffix starts at the dot. Every row of one part has the same width.
 */
export const WORDMARK_HEIGHT = 3;

export const WORDMARK_NAME: readonly string[] = [
  "█▄▄   ▄▄▄  ▄▄▄  ▄▄▄   ▄▄▄  ",
  "█  █ █  █  █  █ █  █ █  █  ",
  "▀  ▀  ▀▀▀▀ ▀  ▀ ▀  ▀  ▀▀▀▀ ",
];

export const WORDMARK_SUFFIX: readonly string[] = [
  "   ▄▀▀ ▄▄▄▄  ",
  "  ▀█▀  █ █ █ ",
  "▀  ▀   ▀ ▀ ▀ ",
];
