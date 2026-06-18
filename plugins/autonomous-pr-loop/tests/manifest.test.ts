import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("plugin metadata", () => {
  it("root package exposes the local agent-loop bin while staying private", () => {
    const pkg = readJson("package.json");

    expect(pkg).toMatchObject({
      private: true,
      bin: {
        "agent-loop": "./plugins/autonomous-pr-loop/bin/agent-loop.mjs"
      }
    });
  });

  it("plugin.json matches the measured Codex plugin shape", () => {
    const plugin = readJson("plugins/autonomous-pr-loop/.codex-plugin/plugin.json");
    const schema = readJson("plugins/autonomous-pr-loop/schemas/plugin.schema.json");

    expect(validateSchema(schema, plugin)).toEqual([]);
    expect(plugin).toMatchObject({
      name: "autonomous-pr-loop",
      version: "0.1.0",
      skills: "./skills/",
      interface: {
        displayName: "HOLO-Codex",
        shortDescription: expect.any(String),
        category: "Engineering",
        capabilities: ["Write"],
        defaultPrompt: ["进入 HOLO-Codex，继续跑到 gate"]
      }
    });
  });

  it("marketplace.json matches the measured repo marketplace shape", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");
    const schema = readJson("plugins/autonomous-pr-loop/schemas/marketplace.schema.json");

    expect(validateSchema(schema, marketplace)).toEqual([]);
    expect(marketplace).toMatchObject({
      name: "codex-auto-pr-loop",
      interface: { displayName: "HOLO-Codex" },
      plugins: [
        {
          name: "autonomous-pr-loop",
          source: {
            source: "local",
            path: "./plugins/autonomous-pr-loop"
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL"
          },
          category: "Engineering"
        }
      ]
    });
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function validateSchema(schema: unknown, value: unknown, path = "$"): string[] {
  if (!isRecord(schema)) {
    return [`${path}: schema must be object`];
  }
  const errors: string[] = [];
  if (schema.type === "object") {
    if (!isRecord(value)) {
      return [`${path}: expected object`];
    }
    for (const key of asStringArray(schema.required)) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: required`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateSchema(childSchema, value[key], `${path}.${key}`));
      }
    }
  }
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: expected string`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
    } else {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${path}: expected at least ${schema.minItems} items`);
      }
      if ("contains" in schema) {
        const matched = value.some((item) => validateSchema(schema.contains, item, path).length === 0);
        if (!matched) {
          errors.push(`${path}: no item matched contains schema`);
        }
      }
    }
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${String(schema.const)}`);
  }
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}: expected minLength ${schema.minLength}`);
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
