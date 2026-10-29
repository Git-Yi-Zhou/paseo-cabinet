import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IDEMPOTENT_READ_TOOLS = new Set([
  "list_providers",
  "list_models",
  "list_agents",
  "get_agent_status",
]);

export class PaseoHttpClient {
  constructor(endpoint = process.env.PASEO_MCP_ENDPOINT || "http://127.0.0.1:16767/mcp/agents") {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextRpcId = 1;
    this.initializing = null;
  }

  /**
   * 解析 Paseo MCP Streamable HTTP 响应（兼容 application/json 与 text/event-stream SSE 帧）
   */
  async parseMcpHttpResponse(res) {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const raw = await res.text();
    if (!raw || !raw.trim()) {
      return null;
    }

    if (ct.includes("application/json")) {
      return JSON.parse(raw);
    }

    if (ct.includes("text/event-stream")) {
      const frames = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((payload) => payload && payload !== "[DONE]")
        .map((payload) => {
          try {
            return JSON.parse(payload);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const rpcMsg =
        frames.reverse().find((f) => f.jsonrpc === "2.0" && (f.result !== undefined || f.error !== undefined)) ||
        frames[0];
      if (!rpcMsg) {
        throw new Error(`[paseo-client] SSE 流中未找到合法 JSON-RPC 帧: ${raw.slice(0, 200)}`);
      }
      return rpcMsg;
    }

    // 尝试兜底按 JSON 解析
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`[paseo-client] 不支持的响应 Content-Type "${ct}": ${raw.slice(0, 200)}`);
    }
  }

  /**
   * 当 Paseo Daemon 未启动（ECONNREFUSED）时，尝试直接通过 Paseo.exe 内置 Node 运行时拉起守护进程
   */
  async tryEnsureDaemonRunning() {
    try {
      const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
      const paseoDir = join(localAppData, "Programs", "Paseo");
      const paseoExe = join(paseoDir, "Paseo.exe");
      const runnerJs = join(
        paseoDir,
        "resources",
        "app.asar.unpacked",
        "dist",
        "daemon",
        "node-entrypoint-runner.js"
      );
      const cliJs = join(
        paseoDir,
        "resources",
        "app.asar",
        "node_modules",
        "@getpaseo",
        "cli",
        "dist",
        "index.js"
      );

      if (existsSync(paseoExe) && existsSync(runnerJs)) {
        await execFileAsync(
          paseoExe,
          ["--disable-warning=DEP0040", runnerJs, "node-script", cliJs, "start"],
          {
            timeout: 15_000,
            windowsHide: true,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              PASEO_NODE_ENV: "production",
              PASEO_DESKTOP_MANAGED: "1",
            },
          }
        );
      } else {
        await execFileAsync("paseo", ["start"], { timeout: 10_000, windowsHide: true });
      }
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 建立或重建 MCP Streamable HTTP 会话握手
   */
  async ensureSession(forceReinit = false) {
    if (this.sessionId && !forceReinit) {
      return this.sessionId;
    }
    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      try {
        const initId = this.nextRpcId++;
        const initBody = {
          jsonrpc: "2.0",
          id: initId,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
              name: "paseo-cabinet-bridge",
              version: "0.1.0",
            },
          },
        };

        let res;
        try {
          res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(initBody),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          // 若连接被拒绝，尝试自动启动 Paseo Daemon 后再试一次
          const started = await this.tryEnsureDaemonRunning();
          if (!started) {
            throw new Error(
              `[paseo-client] 无法连接 Paseo MCP 端点 (${this.endpoint})，且自动启动守护进程失败: ${err.message}`
            );
          }
          res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(initBody),
            signal: AbortSignal.timeout(10_000),
          });
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`[paseo-client] initialize 握手失败 (HTTP ${res.status}): ${text}`);
        }

        const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
        await this.parseMcpHttpResponse(res);
        this.sessionId = sid || "stateless";

        // 发送 notifications/initialized
        await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(this.sessionId !== "stateless" ? { "Mcp-Session-Id": this.sessionId } : {}),
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});

        return this.sessionId;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  /**
   * 调用上游 Paseo MCP 工具（实施幂等分层超时与重试策略）
   * - 只读工具（list_* / get_*）：25s 超时 + 1 次自动重试
   * - 非幂等写工具（create_agent / send_agent_prompt / delete_agent / stop_agent）：120s 超时 + 0 次自动重试（防重入双发）
   */
  async callTool(toolName, args = {}) {
    const isReadOnly = IDEMPOTENT_READ_TOOLS.has(toolName);
    const timeoutMs = isReadOnly ? 25_000 : 120_000;
    const maxRetries = isReadOnly ? 1 : 0;

    let attempt = 0;
    while (true) {
      try {
        await this.ensureSession(false);
        const rpcId = this.nextRpcId++;
        const payload = {
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        };

        let res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(this.sessionId && this.sessionId !== "stateless"
              ? { "Mcp-Session-Id": this.sessionId }
              : {}),
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        // 若守护进程重启导致 Session 失效（400/404），重建一次 Session（仅在 HTTP 层握手失效时重连）
        if (res.status === 400 || res.status === 404) {
          await this.ensureSession(true);
          res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(this.sessionId && this.sessionId !== "stateless"
                ? { "Mcp-Session-Id": this.sessionId }
                : {}),
              "MCP-Protocol-Version": "2025-06-18",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`[paseo-client] HTTP ${res.status} 调用 ${toolName} 失败: ${errText}`);
        }

        const rpcMsg = await this.parseMcpHttpResponse(res);
        if (rpcMsg?.error) {
          throw new Error(
            `[paseo-client] RPC Error (${rpcMsg.error.code}): ${rpcMsg.error.message}`
          );
        }

        return rpcMsg?.result ?? { content: [{ type: "text", text: JSON.stringify(rpcMsg) }] };
      } catch (err) {
        if (attempt < maxRetries) {
          attempt++;
          await this.ensureSession(true).catch(() => {});
          continue;
        }
        throw err;
      }
    }
  }
}
