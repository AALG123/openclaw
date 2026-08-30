import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-materialize.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { prepareNativeMcpPolicy, requiresPreparedNativeMcpPolicy } from "./native-mcp-policy.js";

function catalog(): McpToolCatalog {
  const tools = [
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "read_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "read",
    },
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "delete_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "delete",
      excludedByConfiguredFilter: true as const,
    },
    {
      serverName: "docs?",
      safeServerName: "docs-2",
      toolName: "read_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "other read",
      deniedBySession: true as const,
    },
  ];
  return {
    version: 1,
    generatedAt: 1,
    servers: {
      "docs!": { serverName: "docs!", safeServerName: "docs", launchSummary: "test", toolCount: 1 },
      "docs?": {
        serverName: "docs?",
        safeServerName: "docs-2",
        launchSummary: "test",
        toolCount: 0,
      },
    },
    tools: [tools[0]!],
    sessionDeniedTools: [tools[2]!],
    policyTools: tools,
  };
}

function runtime(value: McpToolCatalog): SessionMcpRuntime {
  return {
    sessionId: "session-1",
    workspaceDir: "/tmp/openclaw-native-mcp-policy",
    configFingerprint: "test",
    createdAt: 1,
    lastUsedAt: 1,
    getCatalog: async () => value,
    peekCatalog: () => value,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  };
}

describe("prepareNativeMcpPolicy", () => {
  it.each([
    {
      label: "configured MCP filters",
      config: {},
      mcpServers: { docs: { toolFilter: { include: ["read_*"] } } },
      expected: true,
    },
    {
      label: "an MCP namespace deny",
      config: { tools: { deny: ["docs__delete_*"] } },
      mcpServers: { docs: { command: "node" } },
      expected: true,
    },
    {
      label: "an unrelated core deny",
      config: { tools: { deny: ["exec"] } },
      mcpServers: { docs: { command: "node" } },
      expected: false,
    },
  ])("resolves catalog preparation for $label", ({ config, mcpServers, expected }) => {
    expect(
      requiresPreparedNativeMcpPolicy({
        capabilityProfile: resolveConversationCapabilityProfile({ config }),
        mcpServers,
      }),
    ).toBe(expected);
  });

  it("preserves raw/safe identities and intersects effective, configured, and session policy", async () => {
    const config = { tools: { allow: ["docs__*"], deny: ["docs__delete_*"] } };
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(catalog()),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers["docs!"]).toMatchObject({
      safeServerName: "docs",
      allowedTools: ["read_docs"],
      deniedTools: ["delete_docs"],
    });
    expect(prepared.servers["docs?"]).toMatchObject({
      safeServerName: "docs-2",
      allowedTools: [],
      deniedTools: ["read_docs"],
    });
  });

  it("treats an empty runtime allowlist as an exact deny-all cap", async () => {
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(catalog()),
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({}),
      runtimeToolsAllow: [],
      warn: () => {},
    });
    expect(Object.values(prepared.servers).flatMap((server) => server.allowedTools)).toEqual([]);
  });

  it("uses catalog-assigned identities for truncated server and colliding tool names", async () => {
    const serverNames = [
      "docs.production.endpoint.with.a.long.shared.prefix.alpha",
      "docs.production.endpoint.with.a.long.shared.prefix.beta",
    ];
    const safeNames = assignSafeServerNames(serverNames);
    const rawTools = [
      "read.docs.with.a.long.shared.prefix.alpha",
      "read:docs:with:a:long:shared:prefix:alpha",
    ];
    const policyTools = rawTools.map((toolName) => ({
      serverName: serverNames[1]!,
      safeServerName: safeNames.get(serverNames[1]!)!,
      toolName,
      inputSchema: Type.Object({}),
      fallbackDescription: toolName,
    }));
    const collisionCatalog: McpToolCatalog = {
      version: 1,
      generatedAt: 1,
      servers: Object.fromEntries(
        serverNames.map((serverName) => [
          serverName,
          {
            serverName,
            safeServerName: safeNames.get(serverName)!,
            launchSummary: "test",
            toolCount: serverName === serverNames[1] ? policyTools.length : 0,
          },
        ]),
      ),
      tools: policyTools,
      policyTools,
    };
    const target = buildBundleMcpToolsFromCatalog({ catalog: collisionCatalog }).find((tool) =>
      tool.name.endsWith("-2"),
    );
    expect(target).toBeDefined();
    const config = { tools: { allow: [target!.name] } };
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(collisionCatalog),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers[serverNames[1]!]?.allowedTools).toEqual([
      getPluginToolMeta(target!)?.mcp?.toolName,
    ]);
    expect(safeNames.get(serverNames[0]!)).not.toBe(safeNames.get(serverNames[1]!));
  });
});
