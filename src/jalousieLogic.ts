/**
 * Pure helpers for jalousie position math, state, and PLC response parsing.
 *
 * Kept free of homebridge / network imports so they can be exercised
 * directly from unit tests without spinning up the platform.
 */

/**
 * HomeKit ↔ PLC position conventions:
 *   HomeKit: 0 = fully closed,  100 = fully open
 *   PLC:     100 = fully closed, 0   = fully open
 */
export const POSITION_STATE = {
  DECREASING: 0,
  INCREASING: 1,
  STOPPED: 2,
} as const;

export type PositionState = typeof POSITION_STATE[keyof typeof POSITION_STATE];

export type Direction = 'up' | 'down' | 'none';

export function homekitToPlcPosition(homekit: number): number {
  return 100 - homekit;
}

export function plcToHomekitPosition(plc: number): number {
  return 100 - plc;
}

/**
 * Calculate how long the jalousie must move (ms) to traverse from one
 * HomeKit position to another, given the full-travel time.
 */
export function calculateMovementTimeMs(
  upDownTimeMs: number,
  fromHomekit: number,
  toHomekit: number,
): number {
  const delta = Math.abs(toHomekit - fromHomekit);
  return Math.ceil(upDownTimeMs * (delta / 100));
}

/**
 * Decide which direction the jalousie should move to reach the target.
 *  - 'up'   = opening (HomeKit position increasing)
 *  - 'down' = closing (HomeKit position decreasing)
 *  - 'none' = already at target
 */
export function directionForTarget(
  fromHomekit: number,
  toHomekit: number,
): Direction {
  if (toHomekit === fromHomekit) {
    return 'none';
  }
  return toHomekit > fromHomekit ? 'up' : 'down';
}

export function directionToPositionState(direction: Direction): PositionState {
  switch (direction) {
    case 'up':
      return POSITION_STATE.INCREASING;
    case 'down':
      return POSITION_STATE.DECREASING;
    default:
      return POSITION_STATE.STOPPED;
  }
}

/* ------------------------------------------------------------------ *
 * Response parsers                                                    *
 * ------------------------------------------------------------------ */

/**
 * Extract a numeric integer property value from a `GET:...<PROP>,<n>` reply.
 * Returns null if the field cannot be located or parsed.
 */
export function parseIntProperty(response: string, prop: string): number | null {
  if (!response) {
    return null;
  }
  const re = new RegExp(`GET:.*\\.${escapeRegExp(prop)},(\\d+)`);
  const match = response.match(re);
  if (!match || !match[1]) {
    return null;
  }
  const n = parseInt(match[1], 10);
  return Number.isNaN(n) ? null : n;
}

export function parseUpDownTime(response: string): number | null {
  return parseIntProperty(response, 'UPDWTIME');
}

export function parsePosit(response: string): number | null {
  return parseIntProperty(response, 'POSIT');
}

/**
 * Extract a quoted string property value from a `GET:...<PROP>,"<s>"` reply.
 */
export function parseQuotedProperty(response: string, prop: string): string | null {
  if (!response) {
    return null;
  }
  const re = new RegExp(`GET:.*${escapeRegExp(prop)},"(.*)"`);
  const match = response.match(re);
  return match && match[1] !== undefined ? match[1] : null;
}

/**
 * Whether a boolean property reply (e.g. `_run`, `_up`, `_down`) reports true.
 * The PLC may use either `,1` or `,TRUE`.
 */
export function isFlagTrue(response: string): boolean {
  if (!response) {
    return false;
  }
  return response.includes(',1') || response.includes(',TRUE');
}

/**
 * Parse a LIST: response and return distinct CJALOUSIE block paths.
 */
export function parseJalousieBlocks(listResponse: string): string[] {
  const lines = listResponse.split('\n');
  const blocks = new Set<string>();
  for (const line of lines) {
    if (line.includes('.CJALOUSIE.')) {
      const match = line.match(/LIST:(.*?)\.CJALOUSIE\./);
      if (match && match[1]) {
        blocks.add(match[1] + '.CJALOUSIE');
      }
    }
  }
  return Array.from(blocks);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
