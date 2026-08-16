// Process exit codes for the CLI entrypoint. 130 follows the shell convention
// for a process terminated by SIGINT (128 + 2).
export const EXIT_CODE_ERROR = 1;
export const EXIT_CODE_KEYBOARD_INTERRUPT = 130;

export const MAX_COMMAND_COMPLETION_WINDOW = 0.1;

export const PROCESS_SHUTDOWN_TIMEOUT = 2.0;
export const FORCE_EXIT_DELAY_SECONDS = 2;

export const RECENT_OUTPUT_LINES = 20;
export const LAST_COMMANDS_COUNT = 5;

export const BYTES_TO_MB = 1024 * 1024;

export const UTILIZATION_PERCENTAGE_BASE = 100;
export const LARGE_BUFFER_THRESHOLD = 10 * 1024 * 1024;
export const SIGNIFICANT_LOG_THRESHOLD = 100_000;

export const CHUNK_JOIN_THRESHOLD = 100;

export const LARGE_IO_THRESHOLD = 10_000;
export const SLOW_OPERATION_THRESHOLD = 1.0;

// Bounds memory on long-lived sessions; oldest entries are dropped when
// exceeded.
export const MAX_COMMAND_HISTORY = 1000;

/**
 * PTY geometry and terminal type.
 *
 * OpenROAD runs a readline-style line editor when stdin is a TTY. At a narrow
 * width that editor horizontally scrolls long commands, redrawing the whole
 * visible window once per character -- a single 75-character read_liberty turns
 * into a cascade of near-identical lines that swamps the real output. A width
 * far beyond any realistic command avoids the redraw entirely.
 *
 * TERM=dumb tells readline to skip the fancy editing layer (bracketed paste,
 * horizontal scroll, cursor addressing) that we neither need nor can interpret.
 */
export const PTY_COLS = 4096;
export const PTY_ROWS = 24;
export const PTY_TERM = "dumb";

/**
 * Line terminator written after each command. A real Enter key sends carriage
 * return, and a line editor in raw mode binds CR -- not LF -- to accept-line.
 * Sending LF can leave the command sitting unsubmitted in the edit buffer.
 */
export const PTY_LINE_TERMINATOR = "\r";

/**
 * Budget for the startup handshake. This has to cover the whole cold start --
 * loading a large OpenROAD binary and reaching its prompt -- not just the probe
 * round-trip, because spawning does not wait for readiness. Generous on
 * purpose: the handshake exists to catch a session that will never respond, and
 * failing a slow-but-healthy start would be worse than the bug it prevents.
 */
export const SESSION_HANDSHAKE_TIMEOUT_MS = 60_000;
