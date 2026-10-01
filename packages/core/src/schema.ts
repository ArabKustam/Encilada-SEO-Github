import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { UsageError } from "./exit.js";

/** `schemas/` at the repository root is the source of truth for all data contracts. */
const SCHEMA_DIR = fileURLToPath(new URL("../../../schemas/", import.meta.url));
const SCHEMA_SUFFIX = ".schema.json";

let ajv: Ajv2020 | null = null;

function instance(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true });
    for (const file of readdirSync(SCHEMA_DIR)) {
      if (!file.endsWith(SCHEMA_SUFFIX)) continue;
      const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
      ajv.addSchema(schema, file.slice(0, -SCHEMA_SUFFIX.length));
    }
  }
  return ajv;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate `data` against `schemas/<name>.schema.json`. */
export function validate(name: string, data: unknown): ValidationResult {
  const validator = instance().getSchema(name);
  if (!validator) throw new Error(`Unknown schema: ${name}`);
  const valid = validator(data) as boolean;
  const errors = (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { valid, errors };
}

export function assertValid(name: string, data: unknown): void {
  const { valid, errors } = validate(name, data);
  if (!valid) throw new UsageError(`Документ не соответствует схеме ${name}: ${errors.join("; ")}`);
}
