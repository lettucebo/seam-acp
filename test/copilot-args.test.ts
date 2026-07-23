import { describe, it, expect } from "vitest";
import { buildCopilotAcpArgs } from "../src/agents/profiles/copilot.js";

describe("buildCopilotAcpArgs", () => {
  it("always requests the long-context tier (forward-compat) over ACP", () => {
    expect(buildCopilotAcpArgs()).toEqual(["--acp", "--context", "long_context"]);
  });

  it("appends the additional MCP config AFTER the context flag when provided", () => {
    expect(buildCopilotAcpArgs('{"mcpServers":{}}')).toEqual([
      "--acp",
      "--context",
      "long_context",
      "--additional-mcp-config",
      '{"mcpServers":{}}',
    ]);
  });

  it("omits the MCP flag for empty/undefined config", () => {
    expect(buildCopilotAcpArgs(undefined)).toEqual(["--acp", "--context", "long_context"]);
    expect(buildCopilotAcpArgs("")).toEqual(["--acp", "--context", "long_context"]);
  });
});
