/** Projects the canonical conversation tool policy into raw native MCP identities. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpConfig } from "../plugins/bundle-mcp.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-materialize.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type {
  McpToolCatalog,
  PreparedNativeMcpPolicy,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { isRecord } from "./bundle-mcp-adapter.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { mayMatchGlobWithPrefix } from "./glob-pattern.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

function denyMayTargetConfiguredMcp(
  denylist: readonly string[],
  mcpServers: BundleMcpConfig["mcpServers"] | undefined,
): boolean {
  const prefixes = [...assignSafeServerNames(Object.keys(mcpServers ?? {})).values()].map(
    (serverName) => normalizeToolPolicyName(serverName + TOOL_NAME_SEPARATOR),
  );
  return denylist.some((entry) => {
    const normalized = normalizeToolPolicyName(entry);
    return (
      normalized === "bundle-mcp" ||
      normalized === "group:plugins" ||
      prefixes.some(
        (prefix) => normalized.startsWith(prefix) || mayMatchGlobWithPrefix(normalized, prefix),
      )
    );
  });
}

/** True when canonical conversation policy needs a concrete native MCP catalog. */
export function requiresPreparedNativeMcpPolicy(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  runtimeToolsAllow?: string[];
  mcpServers?: BundleMcpConfig["mcpServers"];
}): boolean {
  if (params.runtimeToolsAllow !== undefined) {
    return true;
  }
  if (
    Object.values(params.mcpServers ?? {}).some((server) => {
      const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : undefined;
      return Array.isArray(toolFilter?.include) || Array.isArray(toolFilter?.exclude);
    })
  ) {
    return true;
  }
  const policy = params.capabilityProfile.policy;
  return (
    denyMayTargetConfiguredMcp(policy.explicitToolDenylist, params.mcpServers) ||
    policy.explicitToolAllowlist.some((entry) => normalizeToolPolicyName(entry) !== "*")
  );
}

function buildPolicyProjectionCatalog(catalog: McpToolCatalog): McpToolCatalog {
  const policyTools = catalog.policyTools ?? [
    ...catalog.tools,
    ...(catalog.sessionDeniedTools ?? []),
  ];
  return {
    ...catalog,
    // Native clients can expose every raw MCP tool, including App-only tools.
    // Remove only presentation visibility while assigning canonical safe names.
    tools: policyTools.map(({ uiVisibility: _uiVisibility, ...tool }) => tool),
    sessionDeniedTools: undefined,
  };
}

export async function prepareNativeMcpPolicy(params: {
  runtime: SessionMcpRuntime;
  config?: OpenClawConfig;
  workspaceDir: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  runtimeToolsAllow?: string[];
  warn: (message: string) => void;
}): Promise<PreparedNativeMcpPolicy> {
  params.runtime.markUsed();
  const catalog = await params.runtime.getCatalog();
  const policyCatalog = buildPolicyProjectionCatalog(catalog);
  const allTools = buildBundleMcpToolsFromCatalog({ catalog: policyCatalog });
  const runtimeAllowed = applyEmbeddedAttemptToolsAllow(allTools, params.runtimeToolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const effectiveAllowed = applyFinalEffectiveToolPolicy({
    bundledTools: runtimeAllowed,
    config: params.config,
    workspaceDir: params.workspaceDir,
    conversationCapabilityProfile: params.capabilityProfile,
    warn: params.warn,
  });
  const effectiveAllowedNames = new Set(effectiveAllowed.map((tool) => tool.name));
  const servers: PreparedNativeMcpPolicy["servers"] = {};

  for (const tool of allTools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (!mcp || mcp.operation !== "tool") {
      continue;
    }
    const server = (servers[mcp.serverName] ??= {
      serverName: mcp.serverName,
      safeServerName: mcp.safeServerName,
      allowedTools: [],
      deniedTools: [],
    });
    const allowed =
      !mcp.excludedByConfiguredFilter &&
      !mcp.deniedBySession &&
      effectiveAllowedNames.has(tool.name);
    (allowed ? server.allowedTools : server.deniedTools).push(mcp.toolName);
  }

  for (const server of Object.values(servers)) {
    server.allowedTools = [...new Set(server.allowedTools)].toSorted();
    server.deniedTools = [...new Set(server.deniedTools)].toSorted();
  }
  return {
    servers: Object.fromEntries(
      Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/** Applies one prepared policy to the provider-neutral MCP config shape. */
export function applyPreparedNativeMcpPolicy(
  config: BundleMcpConfig,
  policy: PreparedNativeMcpPolicy,
): BundleMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).flatMap(([serverName, server]) => {
        const prepared = policy.servers[serverName];
        if (!prepared || prepared.allowedTools.length === 0) {
          return [];
        }
        const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
        const existingExcluded = Array.isArray(toolFilter.exclude)
          ? toolFilter.exclude.filter((name): name is string => typeof name === "string")
          : [];
        return [
          [
            serverName,
            {
              ...server,
              toolFilter: {
                ...toolFilter,
                include: prepared.allowedTools,
                exclude: [...new Set([...existingExcluded, ...prepared.deniedTools])].toSorted(),
              },
            },
          ],
        ];
      }),
    ),
  };
}

/** Returns raw per-server denials for backends that enforce a deny list. */
export function preparedNativeMcpDenials(
  policy: PreparedNativeMcpPolicy,
): Record<string, string[]> | undefined {
  const entries = Object.values(policy.servers)
    .filter((server) => server.deniedTools.length > 0)
    .map((server) => [server.serverName, server.deniedTools] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
