import { PROTOCOL_VERSION } from "../constants.js";

export const PROTOCOL_VERSION_HEADER = "x-pinboard-protocol-version";

export interface ProtocolCompatibility {
  compatible: boolean;
  expected: number;
  received: number | null;
}

export function parseProtocolVersion(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function checkProtocolCompatibility(value: string | string[] | undefined): ProtocolCompatibility {
  const received = parseProtocolVersion(value);
  return {
    compatible: received === PROTOCOL_VERSION,
    expected: PROTOCOL_VERSION,
    received,
  };
}
