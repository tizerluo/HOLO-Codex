import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const codexHookEvents = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "PreCompact",
  "PostCompact",
  "PermissionRequest"
];

describe("plugin metadata", () => {
  it("root package exposes the npm-ready agent-loop bin and runtime metadata", () => {
    const pkg = readJson("package.json");

    expect(pkg).toMatchObject({
      name: "holo-codex",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/tizerluo/HOLO-Codex.git"
      },
      bin: {
        "agent-loop": "plugins/autonomous-pr-loop/bin/agent-loop.mjs"
      },
      dependencies: {
        "lucide-react": expect.any(String),
        react: expect.any(String),
        "react-dom": expect.any(String),
        tsx: expect.any(String),
        vite: expect.any(String)
      }
    });
    expect((pkg as { private?: unknown }).private).toBeUndefined();
    expect((pkg as { files?: unknown }).files).toEqual(expect.arrayContaining([
      "plugins/autonomous-pr-loop/core/",
      "plugins/autonomous-pr-loop/hooks/",
      "plugins/autonomous-pr-loop/ui/",
      "plugins/autonomous-pr-loop/schemas/",
      "plugins/autonomous-pr-loop/.codex-plugin/",
      "docs/install.md"
    ]));
  });

  it("plugin.json matches the measured Codex plugin shape", () => {
    const plugin = readJson("plugins/autonomous-pr-loop/.codex-plugin/plugin.json");
    const schema = readJson("plugins/autonomous-pr-loop/schemas/plugin.schema.json");

    expect(validateSchema(schema, plugin)).toEqual([]);
    expect(plugin).toMatchObject({
      name: "autonomous-pr-loop",
      version: "0.1.2",
      skills: "./skills/",
      interface: {
        displayName: "HOLO-Codex",
        shortDescription: "Turn long-running Codex workflows into observable Human On Loop systems.",
        longDescription: expect.stringContaining("first bundled PR delivery workflow"),
        developerName: "tizerluo",
        category: "Engineering",
        capabilities: ["Write"],
        defaultPrompt: ["进入 HOLO-Codex，继续跑到 gate"],
        screenshots: ["../../../assets/brand/holo-codex-plugin-card.png"]
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

  it("bundled hooks config uses an empty Codex plugin hooks schema", () => {
    const hooksConfig = readJson("plugins/autonomous-pr-loop/hooks/hooks.json");

    expect(isRecord(hooksConfig)).toBe(true);
    if (!isRecord(hooksConfig)) return;
    const hooks = hooksConfig.hooks;
    expect(isRecord(hooks)).toBe(true);
    if (!isRecord(hooks)) return;
    for (const event of codexHookEvents) {
      expect(hooksConfig).not.toHaveProperty(event);
      expect(hooks).not.toHaveProperty(event);
    }
    expect(Object.keys(hooksConfig).sort()).toEqual(["hooks"]);
    expect(Object.keys(hooks).sort()).toEqual([]);
    expect(JSON.stringify(hooksConfig)).not.toContain("${PLUGIN_ROOT}");
    expect(JSON.stringify(hooksConfig)).not.toContain("hooks/dist/");
    expect(JSON.stringify(hooksConfig)).not.toContain("node ./hooks/dist/");
  });

  it("npm pack dry-run keeps required runtime files and excludes private/dev files", () => {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20
    }))[0] as { name: string; files: Array<{ path: string }> };
    const paths = packed.files.map((file) => file.path).sort();

    expect(packed.name).toBe("holo-codex");
    expect(paths).toEqual(expect.arrayContaining([
      "package.json",
      "plugins/autonomous-pr-loop/bin/agent-loop.mjs",
      "plugins/autonomous-pr-loop/core/cli.ts",
      "plugins/autonomous-pr-loop/hooks/hooks.json",
      "plugins/autonomous-pr-loop/hooks/dist/pre-tool-use.js",
      "plugins/autonomous-pr-loop/ui/index.html",
      "plugins/autonomous-pr-loop/ui/src/main.tsx",
      "plugins/autonomous-pr-loop/schemas/config.schema.json",
      "plugins/autonomous-pr-loop/.codex-plugin/plugin.json",
      "plugins/autonomous-pr-loop/mcp-server/src/index.ts",
      "plugins/autonomous-pr-loop/mcp-server/dist/index.js",
      "plugins/autonomous-pr-loop/skills/autonomous-pr-loop/SKILL.md",
      "docs/install.md",
      "assets/brand/holo-codex-plugin-card.png"
    ]));
    for (const path of paths) {
      expect(path).not.toMatch(/^plugins\/autonomous-pr-loop\/tests\//);
      expect(path).not.toMatch(/^docs\/(plans|specs|research|logseq|pages|journals)\//);
      expect(path).not.toMatch(/^\.agent-loop\//);
      expect(path).not.toBe("AGENTS.md");
      expect(path).not.toBe("CLAUDE.md");
      expect(path).not.toBe("HANDOFF.md");
      expect(path).not.toBe("vitest.config.ts");
      expect(path).not.toMatch(/^\.github\//);
    }
  });

  it("plugin MCP config starts the bundled Node runtime", () => {
    const mcp = readJson("plugins/autonomous-pr-loop/.mcp.json");

    expect(mcp).toMatchObject({
      mcpServers: {
        "autonomous-pr-loop": {
          cwd: ".",
          command: "node",
          args: ["./mcp-server/dist/index.js"]
        }
      }
    });
  });

  it("committed hook dist matches the current hook sources", () => {
    const outdir = mkdtempSync(join(tmpdir(), "agent-loop-hook-dist-"));
    const entries = [
      "plugins/autonomous-pr-loop/hooks/pre-tool-use.ts",
      "plugins/autonomous-pr-loop/hooks/post-tool-use.ts",
      "plugins/autonomous-pr-loop/hooks/user-prompt-submit.ts",
      "plugins/autonomous-pr-loop/hooks/stop.ts",
      "plugins/autonomous-pr-loop/hooks/session-start.ts",
      "plugins/autonomous-pr-loop/hooks/pre-compact.ts",
      "plugins/autonomous-pr-loop/hooks/post-compact.ts",
      "plugins/autonomous-pr-loop/hooks/permission-request.ts"
    ];

    try {
      execFileSync("pnpm", [
        "exec",
        "esbuild",
        ...entries,
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outdir=${outdir}`
      ], { cwd: repoRoot, stdio: "ignore" });

      for (const entry of entries) {
        const fileName = entry.replace(/^.*\//, "").replace(/\.ts$/, ".js");
        expect(readFileSync(resolve(repoRoot, "plugins/autonomous-pr-loop/hooks/dist", fileName), "utf8"))
          .toBe(readFileSync(join(outdir, fileName), "utf8"));
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("committed MCP dist matches the current MCP source", () => {
    const outdir = mkdtempSync(join(tmpdir(), "agent-loop-mcp-dist-"));
    const outfile = join(outdir, "index.js");

    try {
      execFileSync("pnpm", [
        "exec",
        "esbuild",
        "plugins/autonomous-pr-loop/mcp-server/src/index.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outfile=${outfile}`
      ], { cwd: repoRoot, stdio: "ignore" });

      expect(readFileSync(resolve(repoRoot, "plugins/autonomous-pr-loop/mcp-server/dist/index.js"), "utf8"))
        .toBe(readFileSync(outfile, "utf8"));
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
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
