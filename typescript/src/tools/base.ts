import type { OpenROADManager } from "../core/manager.js";

function camelToSnakeKey(key: string): string {
  // camelCase never contains an underscore or a colon, so a key that does is
  // not a field name -- it is data that happens to be an object key, and
  // rewriting it destroys a name the caller has to be able to read back.
  //
  // Two real cases this protects, both seen in live runs: an ORFS make
  // variable (CTS_CLUSTER_SIZE, which became _c_t_s__c_l_u_s_t_e_r__s_i_z_e)
  // and an ORFS metric key carrying a site name
  // (cts__design__rows:FreePDK45_38x28_10R_NP_162NW_34o, which became
  // ...rows:_free_p_d_k45_38x28_10_r__n_p_162_n_w_34_o). The second is why
  // "has no lowercase letters" was not a sufficient test: the key is mostly
  // lowercase and only the payload after the colon is mixed case.
  if (key.includes("_") || key.includes(":")) return key;
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
