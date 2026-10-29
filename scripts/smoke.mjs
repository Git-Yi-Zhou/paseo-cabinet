#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  loadMinistersConfig,
  canonicalModelFamily,
  validateCabinetPrinciples,
  runStartupCanary,
} from "../bridge/domain.mjs";
import { PaseoHttpClient } from "../bridge/paseo-client.mjs";
import { SessionGuard } from "../bridge/session-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];

function assertCheck(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    const msg = `${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(msg);
    console.error(`  [FAIL] ${msg}`);
  }
}

console.log("=== Paseo Cabinet 端到端冒烟与门禁测试 (smoke.mjs) ===");

// 1. 构建产物与 Canary 自检
const ministersConfig = loadMinistersConfig(join(PLUGIN_ROOT, "config", "ministers.json"));
const canary = runStartupCanary(ministersConfig);
assertCheck("启动期值级 Canary 自检通过", canary.ok && canary.ministersCount === 8);
assertCheck(
  "构建产物齐备 (mcp_config.json / source-lock.json / 4 SKILL.md)",
  existsSync(join(PLUGIN_ROOT, "mcp_config.json")) &&
    existsSync(join(PLUGIN_ROOT, "config", "source-lock.json")) &&
    existsSync(join(PLUGIN_ROOT, "skills", "cabinet", "SKILL.md")) &&
    existsSync(join(PLUGIN_ROOT, "skills", "cabinet-roles-coding", "SKILL.md")) &&
    existsSync(join(PLUGIN_ROOT, "skills", "cabinet-roles-writing", "SKILL.md")) &&
    existsSync(join(PLUGIN_ROOT, "skills", "cabinet-roles-research", "SKILL.md"))
);

// 2. canonicalModelFamily 跨 CLI 模型家族解包测试
assertCheck(
  "canonicalModelFamily 识别跨 CLI 挂载的同源模型",
  canonicalModelFamily("kimi", "Zhipu AI Coding Plan/glm-5.3") === "zhipu" &&
    canonicalModelFamily("qwen-code", "deepseek-v4.1-flash(openai)") === "deepseek" &&
    canonicalModelFamily("kimi", "kimi-code/k3.1-pro") === "moonshot" &&
    canonicalModelFamily("qwen-code", "qwen3.8-max(openai)") === "qwen"
);

// 3. 五类组阁原则检查 (Type A - Type E)
const vCoding = validateCabinetPrinciples({ scene: "coding", tier: "standard", ministersConfig });
const vWriting = validateCabinetPrinciples({ scene: "writing", tier: "standard", ministersConfig });
const vResearch = validateCabinetPrinciples({ scene: "research", tier: "standard", ministersConfig });
assertCheck("默认三场景 (coding/writing/research) 全部通过组阁原则检查", vCoding.pass && vWriting.pass && vResearch.pass);

// Type E: qwen-code 传非空 thinkingOptionId 触发硬错误
const vTypeE = validateCabinetPrinciples({
  scene: "coding",
  tier: "standard",
  ministersConfig,
  overrides: [{ seat: "架构官", provider: "qwen-code", model: "qwen3.8-max(openai)", thinkingOptionId: "xhigh" }],
});
assertCheck(
  "Type E (qwen-code 传 xhigh 思考档位) 被硬性拦截",
  !vTypeE.pass && vTypeE.errors.length === 1 && vTypeE.errors[0].type.includes("Type E")
);

// Type B: 全员改为 glm-5.3 触发单源退化警告
const vTypeB = validateCabinetPrinciples({
  scene: "coding",
  tier: "standard",
  ministersConfig,
  overrides: [
    { seat: "红队批判官", provider: "glm-acp-agent", model: "glm-5.3", thinkingOptionId: "xhigh" },
    { seat: "架构官", provider: "glm-acp-agent", model: "glm-5.3", thinkingOptionId: "xhigh" },
    { seat: "工程官", provider: "glm-acp-agent", model: "glm-5.3-flash", thinkingOptionId: "medium" },
    { seat: "成本官", provider: "glm-acp-agent", model: "glm-5.3-flash", thinkingOptionId: "low" },
  ],
});
assertCheck(
  "Type B (全员同源 zhipu 家族) 被三维检查识别告警",
  !vTypeB.pass && vTypeB.warnings.some((w) => w.type.includes("Type B"))
);

// Type C: 高认知席位降配为 flash + low
const vTypeC = validateCabinetPrinciples({
  scene: "coding",
  tier: "standard",
  ministersConfig,
  overrides: [
    { seat: "架构官", provider: "glm-acp-agent", model: "glm-5.3-flash", thinkingOptionId: "low" },
  ],
});
assertCheck(
  "Type C (架构官降配为 flash + low) 触发高认知席位降配警告",
  !vTypeC.pass && vTypeC.warnings.some((w) => w.type.includes("Type C"))
);

// Type D: 同一阁员兼任两席
const vTypeD = validateCabinetPrinciples({
  scene: "coding",
  tier: "standard",
  ministersConfig,
  overrides: [{ seat: "架构官", minister: "feng" }],
});
assertCheck(
  "Type D (锋同场兼任红队与架构官) 触发兼任警告",
  !vTypeD.pass && vTypeD.warnings.some((w) => w.type.includes("Type D"))
);

// 4. SessionGuard 三态门禁 (STAGED -> ACTIVE -> CLOSED)、一次性 overrideCode 与 inflight 并发预算锁测试
const tmpRoot = join(tmpdir(), `paseo-cabinet-smoke-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });

try {
  const guard = new SessionGuard();

  // 4.1 Type E 严禁签发 overrideCode 且严禁激活
  const badRec = guard.stageSession({
    topic: "Type E 测试",
    scene: "coding",
    tier: "standard",
    workspaceRoot: tmpRoot,
    validation: vTypeE,
  });
  assertCheck("Type E 错误不签发 overrideCode", badRec.overrideCode === null);
  let typeEBlocked = false;
  try {
    guard.activateSession({ sessionId: badRec.sessionId });
  } catch (e) {
    typeEBlocked = e.message.includes("CABINET_PRINCIPLE_HARD_ERROR");
  }
  assertCheck("Type E 错误会话禁止激活为 ACTIVE", typeEBlocked);

  // 4.2 Type C 软警告签发一次性 overrideCode，无码拒绝、有码放行、二次复用失效
  const warnRec = guard.stageSession({
    topic: "Type C 覆盖码测试",
    scene: "coding",
    tier: "standard",
    workspaceRoot: tmpRoot,
    validation: vTypeC,
  });
  assertCheck("Type A-D 软警告签发 OVR-XXXX 一次性覆盖码", /^OVR-[0-9A-F]{4}$/.test(warnRec.overrideCode || ""));
  let noCodeBlocked = false;
  try {
    guard.activateSession({ sessionId: warnRec.sessionId });
  } catch (e) {
    noCodeBlocked = e.message.includes("CABINET_OVERRIDE_REQUIRED");
  }
  assertCheck("未传 overrideCode 时拒绝激活软警告会话", noCodeBlocked);

  const code = warnRec.overrideCode;
  const activatedWarn = guard.activateSession({ sessionId: warnRec.sessionId, overrideCode: code });
  assertCheck(
    "传入正确 overrideCode 后成功激活并计入 gateOverrides",
    activatedWarn.state === "ACTIVE" && activatedWarn.gateOverrides === 1 && activatedWarn.overrideCode === null
  );

  // 4.3 正常会话：STAGED 态拦截 create_agent -> ACTIVE 态并发 10 次派发触发 9 次硬顶门禁
  const okRec = guard.stageSession({
    topic: "并发预算门禁与审计闭环测试",
    scene: "coding",
    tier: "standard",
    workspaceRoot: tmpRoot,
    validation: vCoding,
  });

  const capturedUpstreamCalls = [];
  const mockPaseoClient = {
    async callTool(name, args) {
      await new Promise((r) => setTimeout(r, 20));
      capturedUpstreamCalls.push({ name, args });
      return {
        content: [{ type: "text", text: JSON.stringify({ agentId: `mock-agent-${capturedUpstreamCalls.length}` }) }],
      };
    },
  };

  let missingSessionBlocked = false;
  try {
    await guard.interceptSubagentCall("create_agent", { provider: "kimi", model: "kimi-code/k3.1-pro", initialPrompt: "hi" }, mockPaseoClient);
  } catch (e) {
    missingSessionBlocked = e.message.includes("CABINET_SESSION_REQUIRED");
  }
  assertCheck("漏传 cabinetSessionId 硬拦截 (CABINET_SESSION_REQUIRED)", missingSessionBlocked);

  let stagedBlocked = false;
  try {
    await guard.interceptSubagentCall(
      "create_agent",
      { cabinetSessionId: okRec.sessionId, provider: "kimi", model: "kimi-code/k3.1-pro", initialPrompt: "hi" },
      mockPaseoClient
    );
  } catch (e) {
    stagedBlocked = e.message.includes("CABINET_SESSION_NOT_ACTIVE");
  }
  assertCheck("STAGED 态未确认前调用 create_agent 硬拦截 (CABINET_SESSION_NOT_ACTIVE)", stagedBlocked);

  guard.activateSession({ sessionId: okRec.sessionId });

  // 并发发起 10 次调用（standard 硬顶 = 9）
  const providersToTest = [
    { provider: "kimi", model: "kimi-code/k3.1-pro", thinkingOptionId: "high" },
    { provider: "qwen-code", model: "qwen3.8-max(openai)", thinkingOptionId: null },
    { provider: "glm-acp-agent", model: "glm-5.3", thinkingOptionId: "xhigh" },
    { provider: "opencode", model: "deepseek/deepseek-flash", thinkingOptionId: "high" },
  ];

  const tasks = Array.from({ length: 10 }, (_, i) => {
    const p = providersToTest[i % providersToTest.length];
    return guard
      .interceptSubagentCall(
        "create_agent",
        {
          cabinetSessionId: okRec.sessionId,
          provider: p.provider,
          model: p.model,
          initialPrompt: `seat ${i + 1}`,
          settings: { thinkingOptionId: p.thinkingOptionId },
        },
        mockPaseoClient
      )
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.message }));
  });

  const results = await Promise.all(tasks);
  const okCount = results.filter((r) => r.ok).length;
  const blockedCount = results.filter((r) => !r.ok && r.error.includes("CABINET_BUDGET_EXCEEDED")).length;
  assertCheck(
    "inflight 并发预占锁精确放行 9 次、拦截第 10 次 (standard callCap=9)",
    okCount === 9 && blockedCount === 1,
    `ok=${okCount}, blocked=${blockedCount}`
  );

  // 校验只读 modeId 差异化注入与 qwen-code null thinkingOptionId 剥离
  const kimiCall = capturedUpstreamCalls.find((c) => c.args.provider === "kimi");
  const qwenCall = capturedUpstreamCalls.find((c) => c.args.provider === "qwen-code");
  const glmCall = capturedUpstreamCalls.find((c) => c.args.provider === "glm-acp-agent");
  assertCheck(
    "READONLY_MODE_BY_PROVIDER 差异化注入 (kimi/qwen=plan, glm=default) 且剥离 qwen thinkingOptionId",
    kimiCall?.args?.settings?.modeId === "plan" &&
      qwenCall?.args?.settings?.modeId === "plan" &&
      !("thinkingOptionId" in (qwenCall?.args?.settings || {})) &&
      glmCall?.args?.settings?.modeId === "default"
  );

  // 5. Stdio MCP Server 与 cabinet_audit 端到端对账测试
  const serverProc = spawn("node", [join(PLUGIN_ROOT, "bridge", "mcp-server.mjs")], {
    env: { ...process.env, CABINET_MINISTERS_CONFIG: join(PLUGIN_ROOT, "config", "ministers.json") },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const rpcResponses = new Map();
  let stdoutBuf = "";
  serverProc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && rpcResponses.has(msg.id)) {
          rpcResponses.get(msg.id)(msg);
        }
      } catch {
        // ignore
      }
    }
  });

  function callMcpRpc(id, method, params = {}) {
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => rejectRpc(new Error(`RPC timeout: ${method}`)), 10_000);
      rpcResponses.set(id, (msg) => {
        clearTimeout(timer);
        rpcResponses.delete(id);
        resolveRpc(msg);
      });
      serverProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  const initRes = await callMcpRpc(1, "initialize", { protocolVersion: "2024-11-05" });
  assertCheck("MCP Server initialize 握手成功", initRes?.result?.serverInfo?.name === "paseo-cabinet");

  const toolsRes = await callMcpRpc(2, "tools/list", {});
  const toolNames = (toolsRes?.result?.tools || []).map((t) => t.name);
  assertCheck(
    "MCP Server 严格暴露 9 工具白名单且不含 set_agent_mode",
    toolNames.length === 9 &&
      toolNames.includes("cabinet_start") &&
      toolNames.includes("cabinet_audit") &&
      !toolNames.includes("set_agent_mode"),
    `实得: ${toolNames.join(",")}`
  );

  // 为刚才在 tmpRoot 生成了 9 条 dispatch:spawn 事件的会话写入 round-1.jsonl 与 protocol.json，并调用 cabinet_audit
  const sessionDir = join(tmpRoot, ".cabinet", okRec.sessionId);
  writeFileSync(
    join(sessionDir, "round-1.jsonl"),
    JSON.stringify({ seat: "红队批判官", agent: "feng", model: "kimi-code/k3.1-pro", text: "立场书测试" }) + "\n",
    "utf8"
  );
  writeFileSync(
    join(sessionDir, "protocol.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        session: okRec.sessionId,
        tier: "standard",
        topic: okRec.topic,
        brief: "冒烟测试议定书速览",
        seats: [],
        divergence: [{ status: "已解决", text: "D1" }],
        decisions: ["P1"],
        actions: [],
        dissent: [],
        disclosure: "调用轨未用 0 次",
        replayable: true,
        beyond_preanswer: { count: null, items: [] },
        degraded: false,
        cost: {
          calls: 9,
          tokens_est: "14K",
          cap: "9 次委派 / 19000 token(参考)",
          cap_hit: true,
          deviation: "1.0",
          reassigns: 0,
        },
        archived: true,
      },
      null,
      2
    ),
    "utf8"
  );

  const auditRes = await callMcpRpc(3, "tools/call", {
    name: "cabinet_audit",
    arguments: {
      cabinetSessionId: okRec.sessionId,
      workspaceRoot: tmpRoot,
    },
  });
  const auditStructured = auditRes?.result?.structuredContent;
  assertCheck(
    "cabinet_audit 五步闭环对账通过 (ok calls=9) 且自动生成 index.jsonl",
    auditStructured?.ok === true &&
      auditStructured?.auditedCalls === 9 &&
      existsSync(join(tmpRoot, ".cabinet", "index.jsonl"))
  );

  serverProc.kill();

  // 6. 实机 Paseo Daemon 连通性测试（自动拉起或连接 127.0.0.1:16767/mcp/agents）
  const liveClient = new PaseoHttpClient(ministersConfig.paseoEndpoint);
  const liveProvidersRes = await liveClient.callTool("list_providers", {});
  const liveProvidersText = liveProvidersRes?.content?.[0]?.text || "";
  const jsonStart = liveProvidersText.indexOf("{");
  const liveProvidersJson = jsonStart >= 0 ? JSON.parse(liveProvidersText.slice(jsonStart)) : {};
  const availableIds = (liveProvidersJson.providers || [])
    .filter((p) => p.status === "available" || p.installed)
    .map((p) => p.id);
  const requiredProviders = ["kimi", "qwen-code", "glm-acp-agent", "opencode"];
  assertCheck(
    "实机 Paseo Daemon 连通且四大目标 CLI (kimi/qwen-code/glm-acp-agent/opencode) 全部就绪",
    requiredProviders.every((id) => availableIds.includes(id)),
    `available: ${availableIds.join(", ")}`
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n=== 汇总：${pass + fail} 项测试，${pass} 项通过，${fail} 项失败 ===`);
if (failures.length > 0) {
  process.exit(1);
}
