#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CABINET_HOME,
  CONTINUATION_ENABLED,
  MECHANISMS,
  loadMinisters,
  buildInstruction,
  loadMinistersConfig,
  toDshPinningAndPool,
  validateCabinetPrinciples,
  renderPreCabinetDisclosureCard,
  adaptInstructionForPaseo,
  runStartupCanary,
} from "./domain.mjs";
import { PaseoHttpClient } from "./paseo-client.mjs";
import { SessionGuard } from "./session-guard.mjs";

const execFileAsync = promisify(execFile);

const ministersConfig = loadMinistersConfig();
// 启动期执行值级 Canary 自检（P3）
const canaryInfo = runStartupCanary(ministersConfig);
const ministersList = loadMinisters();
const paseoClient = new PaseoHttpClient(
  process.env.PASEO_MCP_ENDPOINT || ministersConfig.paseoEndpoint || "http://127.0.0.1:16767/mcp/agents"
);
const sessionGuard = new SessionGuard();

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 9 工具白名单定义（剔除 set_agent_mode，强制只读模式由网关在 create_agent 内部注入）
 */
const TOOLS = [
  {
    name: "cabinet_start",
    description:
      "开启或确认一场 Paseo 异构内阁议事（双阶段 P9 门禁）：阶段 1（不传 confirm 或 confirm=false）返回 STAGED 态会话 ID 与《组阁前默认钉扎披露卡》，供向用户展示并调用 ask_question 确认或改定；阶段 2（用户确认后传 sessionId 与 confirm=true）激活会话为 ACTIVE 并返回完整内阁议事编排计划。",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "议事议题（阶段 1 必填；阶段 2 可由已暂存的 sessionId 继承）",
        },
        scene: {
          type: "string",
          enum: ["coding", "writing", "research", "general"],
          description: "议题场景角色包（coding / writing / research / general）",
        },
        tier: {
          type: "string",
          enum: ["standard", "advanced", "max"],
          description: "议事档位：standard=4席×1轮(硬顶9次)、advanced=5席×2轮(硬顶16次)、max=6席×2轮(硬顶19次)",
        },
        goal: {
          type: "string",
          description: "期望产出目标",
        },
        roles: {
          type: "array",
          items: { type: "string" },
          description: "自定义席位名称列表（红队批判官固定保留）",
        },
        workspaceRoot: {
          type: "string",
          description: "当前项目工作区绝对路径（用于归档 .cabinet/<sessionId>/）",
        },
        sessionId: {
          type: "string",
          description: "阶段 1 签发的 cabinetSessionId（改定配置、阶段 2 确认激活或中途升档时传入）",
        },
        overrides: {
          type: "array",
          description: "用户对阁员或席位路由的改定项列表",
          items: {
            type: "object",
            properties: {
              seat: { type: "string", description: "要改定的席位名，如 '架构官'" },
              minister: { type: "string", description: "要改定的阁员键，如 'feng'|'yuan'|'li'|'shen'|'ju'|'mou'|'zhong'|'gu'" },
              provider: { type: "string", description: "CLI provider: kimi | qwen-code | glm-acp-agent | opencode" },
              model: { type: "string", description: "模型 ID，如 kimi-code/k3.1-pro, qwen3.8-max(openai), glm-5.3, glm-5.3-flash, deepseek/deepseek-flash" },
              thinkingOptionId: {
                type: ["string", "null"],
                description: "思考强度档位（qwen-code 传 null）",
              },
            },
          },
        },
        confirm: {
          type: "boolean",
          description: "是否已获用户显式确认开议（false=生成/更新披露卡并处于 STAGED；true=跃迁为 ACTIVE 并返回完整编排计划）",
        },
        overrideCode: {
          type: "string",
          description: "当存在 Type A–D 组阁原则软警告且用户明确要求强制放行时，传入披露卡签发的一次性覆盖码 OVR-XXXX",
        },
      },
    },
  },
  {
    name: "cabinet_audit",
    description:
      "内阁议事五步闭环审计与收尾工具：核验 .cabinet/<cabinetSessionId>/ 下的 round-1.jsonl、protocol.json 与 events.jsonl，调用 dsh-cabinet/scripts/audit.mjs 精确对账调用次数，自动追加写入 .cabinet/index.jsonl，并自动销毁本场全部 Paseo 阁员进程后关闭会话。",
    inputSchema: {
      type: "object",
      properties: {
        cabinetSessionId: {
          type: "string",
          description: "本场内阁会话 ID",
        },
        workspaceRoot: {
          type: "string",
          description: "项目工作区根路径（含 .cabinet 目录）",
        },
      },
      required: ["cabinetSessionId"],
    },
  },
  {
    name: "list_providers",
    description: "列出本机 Paseo Daemon 已安装的 CLI Coding Agent Providers 及其可用性与模式目录",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean" },
      },
    },
  },
  {
    name: "list_models",
    description: "查询指定 Paseo CLI Provider 支持的模型列表及真实 thinkingOptions 枚举",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider ID（kimi / qwen-code / glm-acp-agent / opencode）",
        },
      },
      required: ["provider"],
    },
  },
  {
    name: "create_agent",
    description:
      "在 Paseo 中创建并派发一名内阁阁员子智能体（受 cabinetSessionId 门禁与预算硬顶保护，网关自动注入只读 modeId 并记录 dispatch:spawn 事件）",
    inputSchema: {
      type: "object",
      properties: {
        cabinetSessionId: {
          type: "string",
          description: "必填：处于 ACTIVE 状态的 cabinetSessionId（由 cabinet_start(confirm:true) 激活）",
        },
        provider: {
          type: "string",
          description: "CLI Provider（kimi / qwen-code / glm-acp-agent / opencode）",
        },
        model: {
          type: "string",
          description: "钉扎模型名",
        },
        cwd: {
          type: "string",
          description: "阁员工作目录绝对路径",
        },
        title: {
          type: "string",
          description: "阁员席位标题，如 '红队批判官·锋'",
        },
        initialPrompt: {
          type: "string",
          description: "内嵌了阁员人格、角色卡、议题材料与输出格式要求的完整简报",
        },
        waitForTurnComplete: {
          type: "boolean",
          description: "是否等待本轮回答完成再返回（并发派发建议 false 后用 get_agent_status 收齐，或并行调用传 true）",
        },
        settings: {
          type: "object",
          properties: {
            thinkingOptionId: {
              type: ["string", "null"],
              description: "思考强度档位（qwen-code 请勿传或传 null）",
            },
          },
        },
      },
      required: ["cabinetSessionId", "provider", "model", "initialPrompt"],
    },
  },
  {
    name: "send_agent_prompt",
    description:
      "向已创建的 Paseo 阁员发送二轮交叉质询或点名追问（受 cabinetSessionId 门禁与预算硬顶保护，自动记录 dispatch:send_message 事件）",
    inputSchema: {
      type: "object",
      properties: {
        cabinetSessionId: {
          type: "string",
          description: "必填：处于 ACTIVE 状态的 cabinetSessionId",
        },
        agentId: {
          type: "string",
          description: "目标阁员的 Paseo agentId",
        },
        prompt: {
          type: "string",
          description: "质询或追问内容",
        },
        waitForTurnComplete: {
          type: "boolean",
          description: "是否等待回答完成",
        },
      },
      required: ["cabinetSessionId", "agentId", "prompt"],
    },
  },
  {
    name: "get_agent_status",
    description: "查询 Paseo 阁员当前运行状态与最新输出的立场书/质询报告内容",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        waitForTurnComplete: { type: "boolean" },
        turnTimeoutMs: { type: "number" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "list_agents",
    description: "列出当前 Paseo Daemon 中的所有阁员智能体状态",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "delete_agent",
    description: "销毁指定的 Paseo 阁员智能体进程",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
    },
  },
];

async function handleCabinetStart(args = {}) {
  const existing = args.sessionId ? sessionGuard.getSession(args.sessionId) : null;
  const topic = String(args.topic || existing?.topic || "").trim();
  if (!topic) {
    throw new Error("cabinet_start: 参数 topic 必填（首次调用须提供审议议题）。");
  }

  const scene = args.scene || existing?.scene || "general";
  const tier = args.tier || existing?.tier || "standard";
  const goal = args.goal !== undefined ? args.goal : existing?.goal || "";
  const roles = args.roles !== undefined ? args.roles : existing?.roles || null;
  const workspaceRoot = resolve(args.workspaceRoot || existing?.workspaceRoot || process.cwd());
  const overrides = args.overrides !== undefined ? args.overrides : existing?.overrides || [];

  // 阶段 1：未传 confirm:true（或改定配置重跑预检）-> 生成/更新 STAGED 会话并返回披露卡
  if (!args.confirm) {
    const validation = validateCabinetPrinciples({
      scene,
      tier,
      ministersConfig,
      overrides,
      customRoles: roles,
    });

    const record = sessionGuard.stageSession({
      sessionId: args.sessionId,
      topic,
      scene,
      tier,
      goal,
      roles,
      workspaceRoot,
      overrides,
      validation,
    });

    const cardText = renderPreCabinetDisclosureCard({
      sessionId: record.sessionId,
      topic: record.topic,
      scene: record.scene,
      tier: record.tier,
      seats: record.seats,
      ministersConfig,
      dimResult: validation.dimResult,
      errors: validation.errors,
      warnings: validation.warnings,
      overrideCode: record.overrideCode,
    });

    return {
      content: [{ type: "text", text: cardText }],
      structuredContent: {
        status: record.state,
        sessionId: record.sessionId,
        pass: validation.pass,
        errors: validation.errors,
        warnings: validation.warnings,
        overrideCode: record.overrideCode,
      },
    };
  }

  // 阶段 2：confirm === true -> 必须先有已暂存的 STAGED/ACTIVE 会话
  if (!args.sessionId || !existing) {
    throw new Error(
      "CABINET_STAGE_REQUIRED: 严禁跳过阶段 1 直接传 confirm:true！请先调用 cabinet_start（不传 confirm）获取默认钉扎披露卡并向用户确认，再携带签发的 sessionId 调用 cabinet_start({ sessionId, confirm: true })。"
    );
  }

  // 若用户在 confirm:true 时同时夹带了新的 overrides，强制退回 STAGED 让用户先看新披露卡
  if (Array.isArray(args.overrides) && args.overrides.length > 0 && existing.state === "STAGED") {
    const validation = validateCabinetPrinciples({
      scene,
      tier,
      ministersConfig,
      overrides: args.overrides,
      customRoles: roles,
    });
    const record = sessionGuard.stageSession({
      sessionId: existing.sessionId,
      topic,
      scene,
      tier,
      goal,
      roles,
      workspaceRoot,
      overrides: args.overrides,
      validation,
    });
    const cardText = renderPreCabinetDisclosureCard({
      sessionId: record.sessionId,
      topic: record.topic,
      scene: record.scene,
      tier: record.tier,
      seats: record.seats,
      ministersConfig,
      dimResult: validation.dimResult,
      errors: validation.errors,
      warnings: validation.warnings,
      overrideCode: record.overrideCode,
    });
    return {
      content: [
        {
          type: "text",
          text: `> ⚠️ 检测到包含新的席位改定（overrides），已更新披露卡并保持 \`STAGED\` 状态。请向用户展示改定后的披露卡并确认后，再调用 \`cabinet_start({ sessionId: "${record.sessionId}", confirm: true })\`。\n\n${cardText}`,
        },
      ],
    };
  }

  const activeSession = sessionGuard.activateSession({
    sessionId: existing.sessionId,
    tier,
    overrideCode: args.overrideCode,
    workspaceRoot,
  });

  const { dshPinning, dshPool } = toDshPinningAndPool(ministersConfig, activeSession.overrides);
  const rawInstruction = buildInstruction({
    topic: activeSession.topic,
    scene: activeSession.scene,
    roles: activeSession.roles,
    tier: activeSession.tier,
    goal: activeSession.goal,
    ministers: ministersList,
    pinning: dshPinning,
    pool: dshPool,
    continuation: CONTINUATION_ENABLED,
    mechanisms: MECHANISMS,
  });

  const adaptedInstruction = adaptInstructionForPaseo(rawInstruction, {
    sessionId: activeSession.sessionId,
    seats: activeSession.seats,
  });

  return {
    content: [{ type: "text", text: adaptedInstruction }],
    structuredContent: {
      status: activeSession.state,
      sessionId: activeSession.sessionId,
      tier: activeSession.tier,
      maxSubagentCalls: activeSession.maxSubagentCalls,
      used: activeSession.used,
    },
  };
}

/**
 * 五步闭环审计（P7）：
 * 1) 归档文件完整性检查（round-1.jsonl, protocol.json, events.jsonl）
 * 2) 追加 cost:final 决算事件到 events.jsonl
 * 3) 调用 dsh-cabinet/scripts/audit.mjs 并用 ^<sessionId>: ok calls=(\d+) 精确匹配当场对账结果
 * 4) 自动追加一条完整记录到 .cabinet/index.jsonl
 * 5) 自动清理本场全部 Paseo 阁员进程并置会话为 CLOSED
 */
async function handleCabinetAudit(args = {}) {
  const sid = String(args.cabinetSessionId || "").trim();
  if (!sid) {
    throw new Error("cabinet_audit: 必须提供 cabinetSessionId。");
  }

  const session = sessionGuard.getSession(sid);
  const root = resolve(args.workspaceRoot || session?.workspaceRoot || process.cwd());
  const sessionDir = join(root, ".cabinet", sid);

  const requiredFiles = ["round-1.jsonl", "protocol.json", "events.jsonl"];
  for (const f of requiredFiles) {
    const p = join(sessionDir, f);
    if (!existsSync(p) || statSync(p).size === 0) {
      throw new Error(
        `CABINET_ARCHIVE_INCOMPLETE: 归档文件缺失或为空: ${p}。请先写入 round-1.jsonl 与 protocol.json 后再调用 cabinet_audit。`
      );
    }
  }

  const protocolPath = join(sessionDir, "protocol.json");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));

  if (session && session.state !== "CLOSED") {
    sessionGuard.appendEvent(session, {
      phase: "cost",
      actor: "bridge",
      event: "cost:final",
      detail: `calls=${session.used}/${session.maxSubagentCalls}, gate_blocks=${session.gateBlocks}, gate_overrides=${session.gateOverrides}`,
    });
  }

  const auditScript = join(CABINET_HOME, "scripts", "audit.mjs");
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync("node", [auditScript, root], {
      timeout: 15_000,
      windowsHide: true,
    });
    stdout = res.stdout || "";
    stderr = res.stderr || "";
  } catch (err) {
    // audit.mjs 在历史归档有 mismatch 时以 exit 1 退出，故仍提取 stdout 按当场 sessionId 精确判定
    stdout = err.stdout || "";
    stderr = err.stderr || err.message || "";
  }

  const okRegex = new RegExp(`^${escapeRegExp(sid)}:\\s*ok\\s+calls=(\\d+)`, "m");
  const match = stdout.match(okRegex);
  if (!match) {
    const sessionLine =
      stdout
        .split(/\r?\n/)
        .find((l) => l.startsWith(`${sid}:`)) || stdout.trim() || stderr.trim();
    throw new Error(
      `CABINET_AUDIT_MISMATCH: 会话 "${sid}" 未通过 audit.mjs 机器对账！输出：${sessionLine}（提示：请核对 protocol.json 中的 cost.calls 是否等于网关实际派发次数 ${session ? session.used : "N"}）。`
    );
  }

  const auditedCalls = Number(match[1]);

  // 自动写入 .cabinet/index.jsonl
  const indexPath = join(root, ".cabinet", "index.jsonl");
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const alreadyIndexed = existingIndex
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        return JSON.parse(line)?.session === sid;
      } catch {
        return false;
      }
    });

  if (!alreadyIndexed) {
    const tierPath =
      session && session.tierHistory.length > 1
        ? session.tierHistory.join("->")
        : protocol.tier || session?.tier || "standard";
    const indexRow = {
      ts: new Date().toISOString(),
      session: sid,
      topic: protocol.topic || session?.topic || "",
      tier: tierPath,
      seats: Array.isArray(protocol.seats) ? protocol.seats.length : session?.seats?.length || 4,
      verdict: protocol.brief ? String(protocol.brief).slice(0, 80) : "已收敛合议",
      files: existsSync(join(sessionDir, "round-2.jsonl"))
        ? ["round-1.jsonl", "round-2.jsonl", "protocol.json", "events.jsonl"]
        : ["round-1.jsonl", "protocol.json", "events.jsonl"],
      source_doc: null,
      calls: auditedCalls,
      gate_blocks: session?.gateBlocks ?? 0,
      audit: "ok",
      beyond_preanswer: null,
      gate_overrides: session?.gateOverrides ?? 0,
      card_reactions: session?.hadUserModification ? "改定" : "确认",
    };
    appendFileSync(indexPath, JSON.stringify(indexRow) + "\n", "utf8");
  }

  // 自动回收本场创建的全部 Paseo 阁员进程
  const cleanedAgents = [];
  if (session && Array.isArray(session.agentIds)) {
    for (const agentId of session.agentIds) {
      try {
        await paseoClient.callTool("delete_agent", { agentId });
        cleanedAgents.push(agentId);
      } catch {
        // 已停止或已删除的阁员忽略错误
      }
    }
    session.state = "CLOSED";
  }

  const summary = {
    ok: true,
    sessionId: sid,
    audit: "ok",
    auditedCalls,
    gateBlocks: session?.gateBlocks ?? 0,
    gateOverrides: session?.gateOverrides ?? 0,
    cardReactions: session?.hadUserModification ? "改定" : "确认",
    cleanedAgents,
    indexUpdated: !alreadyIndexed,
  };

  return {
    content: [
      {
        type: "text",
        text: `✅ 内阁归档审计通过（${sid}: ok calls=${auditedCalls}），已写入 .cabinet/index.jsonl 并回收 ${cleanedAgents.length} 个 Paseo 阁员进程。\n\n\`\`\`json\n${JSON.stringify(
          summary,
          null,
          2
        )}\n\`\`\``,
      },
    ],
    structuredContent: summary,
  };
}

async function dispatchToolCall(name, args = {}) {
  switch (name) {
    case "cabinet_start":
      return await handleCabinetStart(args);
    case "cabinet_audit":
      return await handleCabinetAudit(args);
    case "create_agent":
    case "send_agent_prompt":
      return await sessionGuard.interceptSubagentCall(name, args, paseoClient);
    case "list_providers":
    case "list_models":
    case "get_agent_status":
    case "list_agents":
    case "delete_agent":
      return await paseoClient.callTool(name, args);
    default:
      throw new Error(
        `[paseo-cabinet] 拒绝调用未授权工具 "${name}"（仅开放 9 工具白名单，set_agent_mode 已禁用）`
      );
  }
}

// —— Stdio JSON-RPC 2.0 传输层（自适应兼容 newline-delimited JSON 与 Content-Length 帧）——

let framingMode = "newline"; // 默认 MCP 标准行分隔 JSON，若首包带 Content-Length 则自动切换

function sendRpcMessage(msg) {
  const json = JSON.stringify(msg);
  if (framingMode === "content-length") {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handleRpcRequest(req) {
  if (!req || typeof req !== "object") return;
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      sendRpcMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "paseo-cabinet",
            version: "0.1.0",
            dshCabinetVersion: canaryInfo.dshCabinetVersion,
          },
        },
      });
      return;
    }

    if (method === "notifications/initialized" || method === "initialized") {
      return;
    }

    if (method === "ping") {
      sendRpcMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendRpcMessage({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS,
        },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await dispatchToolCall(toolName, toolArgs);
        sendRpcMessage({
          jsonrpc: "2.0",
          id,
          result,
        });
      } catch (toolErr) {
        sendRpcMessage({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: toolErr?.message || String(toolErr),
              },
            ],
          },
        });
      }
      return;
    }

    if (id !== undefined) {
      sendRpcMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    }
  } catch (err) {
    if (id !== undefined) {
      sendRpcMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err?.message || String(err),
        },
      });
    }
  }
}

let rawBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  rawBuffer = Buffer.concat([rawBuffer, chunk]);

  while (rawBuffer.length > 0) {
    const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString("utf8");
    if (preview.startsWith("Content-Length:")) {
      framingMode = "content-length";
      const headerEnd = rawBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerStr = rawBuffer.subarray(0, headerEnd).toString("utf8");
      const m = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        rawBuffer = rawBuffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (rawBuffer.length < bodyStart + len) break;
      const bodyStr = rawBuffer.subarray(bodyStart, bodyStart + len).toString("utf8");
      rawBuffer = rawBuffer.subarray(bodyStart + len);
      try {
        handleRpcRequest(JSON.parse(bodyStr));
      } catch {
        // ignore malformed packet
      }
    } else {
      const nlIdx = rawBuffer.indexOf(0x0a); // '\n'
      if (nlIdx === -1) break;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString("utf8").trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        handleRpcRequest(JSON.parse(lineStr));
      } catch {
        // ignore non-json line
      }
    }
  }
});
