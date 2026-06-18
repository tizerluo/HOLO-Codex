import { McpController, type McpControllerOptions } from "./mcp-controller.js";

export interface ControllerHost {
  controller: McpController;
  getController(): McpController;
  dispose(): void;
}

/** Create a shared controller host for MCP and future dashboard consumers. */
export function createControllerHost(options: McpControllerOptions): ControllerHost {
  const controller = new McpController(options);
  return {
    controller,
    getController: () => controller,
    dispose: () => {
      // Reserved for future shared storage/session resources.
    }
  };
}
