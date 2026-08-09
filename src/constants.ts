export const PACKAGE_NAME = "@usepinboard/cli";
export const PRODUCT_NAME = "Pinboard";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_IDLE_MINUTES = 5;
export const DEFAULT_STALE_MINUTES = 30;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_TASK_LABEL_BYTES = 512;
export const MAX_LEASE_NOTE_BYTES = 2048;
export const MAX_REQUEST_BYTES = 64 * 1024;

export const ERROR_CODES = {
  invalidInput: "INVALID_INPUT",
  unauthorized: "UNAUTHORIZED",
  notFound: "NOT_FOUND",
  addressNotFound: "ADDRESS_NOT_FOUND",
  daemonUnavailable: "DAEMON_UNAVAILABLE",
  conflict: "CONFLICT",
  internal: "INTERNAL_ERROR",
} as const;
