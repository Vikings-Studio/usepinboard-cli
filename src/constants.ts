export const PACKAGE_NAME = "@usepinboard/cli";
export const PRODUCT_NAME = "Pinboard";
export const PROTOCOL_VERSION = 1;
// Current hosted endpoint until the custom API domain is configured.
export const DEFAULT_API_URL = "https://pinboard-backend-4p35sr23vq-uc.a.run.app";
export const DEVICE_AUTH_SERVICE = "usepinboard-cli";
export const DEVICE_AUTH_ACCOUNT = "device-auth";
export const DEFAULT_IDLE_MINUTES = 5;
export const DEFAULT_STALE_MINUTES = 30;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_TASK_LABEL_BYTES = 512;
export const MAX_LEASE_NOTE_BYTES = 2048;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_HOOK_BYTES = 8 * 1024 * 1024;

export const ERROR_CODES = {
  invalidInput: "INVALID_INPUT",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
  addressNotFound: "ADDRESS_NOT_FOUND",
  daemonUnavailable: "DAEMON_UNAVAILABLE",
  conflict: "CONFLICT",
  protocolVersionMismatch: "PROTOCOL_VERSION_MISMATCH",
  internal: "INTERNAL_ERROR",
} as const;
