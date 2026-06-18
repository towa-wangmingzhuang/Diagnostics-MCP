import * as vscode from "vscode";
import * as http from "http";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | undefined;
let serverPort: number = 3846;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Diagnostics MCP Server");
  outputChannel.appendLine("✅ EXTENSION ACTIVATED!");
  outputChannel.show();

  const config = vscode.workspace.getConfiguration("diagnostics-mcp-server");
  const autoStart = config.get<boolean>("autoStart", true);
  serverPort = config.get<number>("port", 3846);

  outputChannel.appendLine(
    `📋 Config - AutoStart: ${autoStart}, Port: ${serverPort}`
  );

  if (autoStart) {
    startHttpServer();
  } else {
    outputChannel.appendLine(
      "⏸️ AutoStart disabled - use 'Start HTTP MCP Server' command to start manually"
    );
  }

  const startCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.start",
    () => {
      if (!httpServer || !httpServer.listening) {
        startHttpServer();
        vscode.window.showInformationMessage(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
        outputChannel.appendLine(
          `🚀 HTTP MCP Server manually started on port ${serverPort}`
        );
      } else {
        vscode.window.showInformationMessage(
          `✅ HTTP MCP Server already running on port ${serverPort}`
        );
        outputChannel.appendLine("✅ HTTP MCP Server already running");
      }
    }
  );

  const stopCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.stop",
    () => {
      if (httpServer && httpServer.listening) {
        stopHttpServer();
        vscode.window.showInformationMessage("🛑 HTTP MCP Server stopped");
        outputChannel.appendLine("🛑 HTTP MCP Server stopped");
      } else {
        vscode.window.showInformationMessage("⚠️ HTTP MCP Server not running");
        outputChannel.appendLine("⚠️ HTTP MCP Server not running");
      }
    }
  );

  const statusCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.status",
    () => {
      const isRunning = httpServer && httpServer.listening;
      const status = isRunning ? "RUNNING" : "STOPPED";
      const port = isRunning ? serverPort.toString() : "N/A";
      const url = isRunning ? `http://127.0.0.1:${serverPort}/mcp` : "N/A";

      const diagnosticsResult = getAllDiagnostics();
      const healthResult = getWorkspaceHealth();

      const message = `HTTP MCP Server Status:
📡 Status: ${status}
🌐 Port: ${port}
🔗 URL: ${url}
🛠️ Tools: 5 (all diagnostics, errors, warnings, info, health)
📊 Current Diagnostics: ${diagnosticsResult.total}
💚 Health Score: ${healthResult.healthScore}%`;

      vscode.window.showInformationMessage(message, { modal: true });
      outputChannel.appendLine(
        `Status check: ${status} - Diagnostics: ${diagnosticsResult.total} - Health: ${healthResult.healthScore}%`
      );
    }
  );

  const restartCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.restart",
    () => {
      if (httpServer && httpServer.listening) {
        outputChannel.appendLine("🔄 Restarting HTTP MCP Server...");
        stopHttpServer();
        setTimeout(() => {
          startHttpServer();
          vscode.window.showInformationMessage(
            `🔄 HTTP MCP Server restarted on port ${serverPort}`
          );
          outputChannel.appendLine(
            `✅ HTTP MCP Server restarted on port ${serverPort}`
          );
        }, 500);
      } else {
        startHttpServer();
        vscode.window.showInformationMessage(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
        outputChannel.appendLine(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
      }
    }
  );

  context.subscriptions.push(
    startCommand,
    stopCommand,
    statusCommand,
    restartCommand
  );

  vscode.window.showInformationMessage("✅ Diagnostics MCP - ACTIVATED!");
  console.log("✅ DIAGNOSTICS MCP: ACTIVATED");
}

function startHttpServer() {
  httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const requestPath = req.url?.split("?")[0];

    if (requestPath === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "diagnostics-mcp" }));
      return;
    }

    if (requestPath === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Method not allowed." },
          })
        );
        return;
      }

      const server = createMCPServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      transport.onerror = (error) => {
        outputChannel.appendLine(`MCP transport error: ${error.message}`);
      };

      res.on("close", () => {
        transport.close().catch((error) => {
          outputChannel.appendLine(`Error closing MCP transport: ${error}`);
        });
        server.close().catch((error) => {
          outputChannel.appendLine(`Error closing MCP server: ${error}`);
        });
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        outputChannel.appendLine(`Error handling MCP request: ${error}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32603,
                message: "Internal server error",
              },
            })
          );
        }
      }

      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  httpServer.listen(serverPort, () => {
    outputChannel.appendLine(
      `🚀 HTTP Server started on http://localhost:${serverPort}`
    );
    outputChannel.appendLine(
      `   - Health: http://localhost:${serverPort}/health`
    );
    outputChannel.appendLine(`   - MCP: http://localhost:${serverPort}/mcp`);
    vscode.window.showInformationMessage(
      `🚀 Diagnostics MCP Server running on http://localhost:${serverPort}`
    );
  });

  httpServer.on("error", (error) => {
    outputChannel.appendLine(`❌ HTTP Server error: ${error.message}`);
    vscode.window.showErrorMessage(`HTTP Server error: ${error.message}`);
  });
}

function stopHttpServer() {
  if (httpServer && httpServer.listening) {
    httpServer.close(() => {
      outputChannel.appendLine("🛑 HTTP Server stopped");
    });
    httpServer = undefined;
  }
}

export function deactivate() {
  stopHttpServer();
  console.log("👋 DIAGNOSTICS MCP: DEACTIVATED");
}

function createMCPServer(): Server {
  const server = new Server(
    {
      name: "diagnostics-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getMCPTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    outputChannel.appendLine(`Executing tool: ${toolName}`);

    const filePath = getOptionalFilePathFromArguments(request.params.arguments);
    let toolResult: any;

    if (toolName === "get_all_diagnostics") {
      toolResult = getAllDiagnostics(filePath);
    } else if (toolName === "get_workspace_health") {
      toolResult = getWorkspaceHealth(filePath);
    } else if (toolName === "get_errors") {
      toolResult = getDiagnosticsBySeverity(
        vscode.DiagnosticSeverity.Error,
        filePath
      );
    } else if (toolName === "get_warnings") {
      toolResult = getDiagnosticsBySeverity(
        vscode.DiagnosticSeverity.Warning,
        filePath
      );
    } else if (toolName === "get_info") {
      toolResult = getDiagnosticsBySeverity(
        vscode.DiagnosticSeverity.Information,
        filePath
      );
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(toolResult ?? { status: "empty" }, null, 2),
        },
      ],
    };
  });

  return server;
}

function getMCPTools() {
  const filePathProperty = {
    filePath: {
      type: "string",
      description:
        "Optional absolute or workspace-relative file path to scope the query to a single file",
    },
  };

  return [
    {
      name: "get_all_diagnostics",
      description:
        "Get all diagnostics from the workspace or a specific file",
      inputSchema: {
        type: "object",
        properties: filePathProperty,
      },
    },
    {
      name: "get_workspace_health",
      description:
        "Get workspace health score based on diagnostics, optionally scoped to a single file",
      inputSchema: {
        type: "object",
        properties: filePathProperty,
      },
    },
    {
      name: "get_errors",
      description:
        "Get error-level diagnostics from the workspace or a specific file",
      inputSchema: {
        type: "object",
        properties: filePathProperty,
      },
    },
    {
      name: "get_warnings",
      description:
        "Get warning-level diagnostics from the workspace or a specific file",
      inputSchema: {
        type: "object",
        properties: filePathProperty,
      },
    },
    {
      name: "get_info",
      description:
        "Get info-level diagnostics from the workspace or a specific file",
      inputSchema: {
        type: "object",
        properties: filePathProperty,
      },
    },
  ];
}

function getAllDiagnostics(filePath?: string) {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    const targetUri = filePath ? resolveInputFileUri(filePath) : undefined;
    let totalDiagnostics = 0;
    const diagnosticsList: any[] = [];

    for (const [uri, fileDiagnostics] of diagnostics) {
      if (targetUri && !isEqualUri(uri, targetUri)) {
        continue;
      }

      totalDiagnostics += fileDiagnostics.length;
      for (const diagnostic of fileDiagnostics) {
        diagnosticsList.push({
          file: uri.fsPath,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity:
            diagnostic.severity === 0
              ? "error"
              : diagnostic.severity === 1
                ? "warning"
                : "info",
          message: diagnostic.message || "No message",
          source: diagnostic.source || "unknown",
        });
      }
    }

    return {
      ...(targetUri ? { file: targetUri.fsPath } : {}),
      total: totalDiagnostics,
      diagnostics: diagnosticsList,
      status: totalDiagnostics > 0 ? "found" : "empty",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    outputChannel.appendLine(`Error getting diagnostics: ${error}`);
    return {
      ...(filePath ? { file: filePath } : {}),
      total: 0,
      diagnostics: [],
      status: "error",
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

function getWorkspaceHealth(filePath?: string) {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    const targetUri = filePath ? resolveInputFileUri(filePath) : undefined;
    let errors = 0;
    let warnings = 0;
    let infos = 0;

    for (const [uri, fileDiagnostics] of diagnostics) {
      if (targetUri && !isEqualUri(uri, targetUri)) {
        continue;
      }

      for (const diagnostic of fileDiagnostics) {
        if (diagnostic.severity === 0) errors++;
        else if (diagnostic.severity === 1) warnings++;
        else infos++;
      }
    }

    const totalIssues = errors + warnings + infos;
    const errorPenalty = errors * 10;
    const warningPenalty = warnings * 3;
    const infoPenalty = infos * 1;
    const healthScore = Math.max(
      0,
      Math.min(100, 100 - (errorPenalty + warningPenalty + infoPenalty))
    );

    return {
      ...(targetUri ? { file: targetUri.fsPath } : {}),
      healthScore: Math.round(healthScore),
      status:
        healthScore >= 90
          ? "excellent"
          : healthScore >= 70
            ? "good"
            : healthScore >= 50
              ? "fair"
              : "poor",
      summary: { errors, warnings, infos, total: totalIssues },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    outputChannel.appendLine(`Error calculating workspace health: ${error}`);
    return {
      ...(filePath ? { file: filePath } : {}),
      healthScore: 0,
      status: "error",
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

function getDiagnosticsBySeverity(
  severity: vscode.DiagnosticSeverity,
  filePath?: string
) {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    const targetUri = filePath ? resolveInputFileUri(filePath) : undefined;
    let totalDiagnostics = 0;
    const diagnosticsList: any[] = [];

    for (const [uri, fileDiagnostics] of diagnostics) {
      if (targetUri && !isEqualUri(uri, targetUri)) {
        continue;
      }

      for (const diagnostic of fileDiagnostics) {
        if (diagnostic.severity === severity) {
          totalDiagnostics++;
          diagnosticsList.push({
            file: uri.fsPath,
            line: diagnostic.range.start.line + 1,
            column: diagnostic.range.start.character + 1,
            severity:
              severity === 0 ? "error" : severity === 1 ? "warning" : "info",
            message: diagnostic.message || "No message",
            source: diagnostic.source || "unknown",
          });
        }
      }
    }

    const severityName =
      severity === 0 ? "errors" : severity === 1 ? "warnings" : "info";

    return {
      ...(targetUri ? { file: targetUri.fsPath } : {}),
      count: totalDiagnostics,
      diagnostics: diagnosticsList,
      severityLevel: severityName,
      status: totalDiagnostics > 0 ? "found" : "empty",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const severityName =
      severity === 0 ? "errors" : severity === 1 ? "warnings" : "info";
    outputChannel.appendLine(`Error getting ${severityName}: ${error}`);
    return {
      ...(filePath ? { file: filePath } : {}),
      count: 0,
      diagnostics: [],
      severityLevel: severityName,
      status: "error",
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

function getOptionalFilePathFromArguments(args: unknown): string | undefined {
  const filePath =
    args && typeof args === "object" && "filePath" in args
      ? (args as { filePath?: unknown }).filePath
      : undefined;

  if (filePath === undefined || filePath === null || filePath === "") {
    return undefined;
  }

  if (typeof filePath !== "string") {
    throw new Error("filePath must be a string");
  }

  return filePath;
}

function resolveInputFileUri(filePath: string): vscode.Uri {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("filePath must not be empty");
  }

  if (path.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(`Relative file path requires an open workspace: ${filePath}`);
  }

  if (workspaceFolder.uri.scheme === "file") {
    return vscode.Uri.file(path.resolve(workspaceFolder.uri.fsPath, trimmed));
  }

  const pathSegments = trimmed.split(/[\\/]+/).filter(Boolean);
  return vscode.Uri.joinPath(workspaceFolder.uri, ...pathSegments);
}

function isEqualUri(resource: vscode.Uri, candidate: vscode.Uri): boolean {
  if (resource.scheme !== candidate.scheme) {
    return false;
  }

  return resource.toString() === candidate.toString();
}
