import type { OpenROADManager } from "../core/manager.js";

function camelToSnakeKey(key: string): string {
  // A key with no lowercase letters is not camelCase -- it is a SCREAMING_SNAKE
  // identifier that arrived as data, such as an ORFS make variable
  // (CTS_CLUSTER_SIZE). Converting it produces _c_t_s__c_l_u_s_t_e_r__s_i_z_e
  // and destroys a name the caller has to be able to read back.
  if (!/[a-z]/.test(key)) return key;
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Recursively convert camelCase object keys to snake_case. Idempotent on
 * already-snake_case keys, and leaves SCREAMING_SNAKE keys alone, so opaque
 * payloads keyed by caller-supplied names pass through unchanged.
 */
export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        camelToSnakeKey(k),
        toSnakeCase(v),
      ]),
    );
  }
  return value;
}

/**
 * Base class for MCP tool implementations. Provides the manager dependency
 * and a serialization helper that converts the camelCase domain model to the
 * snake_case wire format.
 */
export abstract class BaseTool {
  protected constructor(protected readonly manager: OpenROADManager) {}

  protected formatResult(result: Record<string, unknown>): string {
    return JSON.stringify(toSnakeCase(result));
  }
}
