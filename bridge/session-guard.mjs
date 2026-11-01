import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { TIERS } from "./domain.mjs";

export const READONLY_MODE_BY_PROVIDER = {
  kimi: "plan",
  "qwen-code": "plan",
  opencode: "plan",
  "glm-acp-agent": "default",
};

function slugifyTopic(topic) {
  const ascii = String(topic || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = randomBytes(2).toString("hex");
  return ascii ? `${ascii}-${rand}` : `cabinet-${rand}`;
}

function extractAgentIdFromMcpResult(result, fallbackId = "") {
  if (!result) return fallbackId;
  if (typeof result.agentId === "string") return result.agentId;
  if (typeof result.id === "string") return result.id;
  const textBlocks = Array.isArray(result.content)
    ? result.content.filter((c) => c && typeof c.text === "string").map((c) => c.text)
    : [];
  for (const t of textBlocks) {
    try {
      const parsed = JSON.parse(t);
      if (parsed?.agentId) return String(parsed.agentId);
      if (parsed?.id) return String(parsed.id);
      if (parsed?.agent?.id) return String(parsed.agent.id);
    } catch {
      const m = t.match(/"(?:agentId|id)"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return fallbackId;
}

export class SessionGuard {
  constructor() {
    /** @type {Map<string, any>} */
    this.sessions = new Map();
  }

  createSessionId(topic, workspaceRoot = process.cwd()) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const base = `${dateStr}-${slugifyTopic(topic)}`;
    const cabDir = join(resolve(workspaceRoot), ".cabinet", base);
    if (!this.sessions.has(base) && !existsSync(cabDir)) {
      return base;
    }
    return `${base}-${randomBytes(2).toString("hex")}`;
  }

  getSession(sessionId, workspaceRoot = process.cwd()) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    return this.recoverSessionFromDisk(sessionId, workspaceRoot);
  }

  recoverSessionFromDisk(sessionId, workspaceRoot = process.cwd()) {
    if (!sessionId) return null;
    const resolvedRoot = resolve(workspaceRoot || process.cwd());
    const eventsPath = join(resolvedRoot, ".cabinet", sessionId, "events.jsonl");
    if (!existsSync(eventsPath)) return null;

    try {
      const lines = readFileSync(eventsPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      const meta = lines.find((l) => l.session_meta) || {};
      const tier = meta.tier || "standard";
      const tierSpec = TIERS[tier] || TIERS.standard;
      let seq = 0;
      let used = 0;
      let gateBlocks = 0;
      let gateOverrides = 0;
      let hadUserModification = false;
      const agentIds = [];
      let seats = [];

      for (const row of lines) {
        if (typeof row.seq === "number" && row.seq > seq) {
          seq = row.seq;
        }
        if (
          typeof row.event === "string" &&
          (row.event.startsWith("dispatch:spawn") || row.event.startsWith("dispatch:send_message"))
        ) {
          used += 1;
          if (row.delegationId && !agentIds.includes(row.delegationId)) {
            agentIds.push(row.delegationId);
          }
        }
        if (row.event === "cost:cap_hit") {
          gateBlocks += 1;
        }
        if (row.event === "steering:cabinet_confirmed" && String(row.detail || "").includes("改定")) {
          hadUserModification = true;
        }
        if (row.event === "setup:disclosure_card_staged" && typeof row.detail === "string") {
          const m = row.detail.match(/^seats=(.+)$/);
          if (m) {
            seats = m[1].split(",").map((item) => {
              const [seat, pm] = item.split(":");
              const slashIdx = (pm || "").indexOf("/");
              return {
                seat,
                provider: slashIdx >= 0 ? pm.slice(0, slashIdx) : pm,
                rawModel: slashIdx >= 0 ? pm.slice(slashIdx + 1) : "",
              };
            });
          }
        }
      }

      const recovered = {
        sessionId,
        state: "ACTIVE",
        topic: meta.topic || "",
        scene: meta.scene || "coding",
        tier,
        tierHistory: [tier],
        goal: "",
        roles: null,
        workspaceRoot: resolvedRoot,
        overrides: [],
        hadUserModification,
        validation: { errors: [], warnings: [], seats },
        seats,
        maxSubagentCalls: meta.cap || tierSpec.callCap,
        used,
        inflight: 0,
        gateBlocks,
        gateOverrides,
        overrideCode: null,
        agentIds,
        seq,
        eventsInitialized: true,
        createdAt: meta.t || new Date().toISOString(),
      };
      this.sessions.set(sessionId, recovered);
      return recovered;
    } catch {
      return null;
    }
  }

  /**
   * 阶段一：创建或更新 STAGED 组阁会话
   */
  stageSession({
    sessionId,
    topic,
    scene = "general",
    tier = "standard",
    goal = "",
    roles = null,
    workspaceRoot = process.cwd(),
    overrides = [],
    validation,
  }) {
    const resolvedRoot = resolve(workspaceRoot || process.cwd());
    const sid = sessionId && this.sessions.has(sessionId)
      ? sessionId
      : sessionId || this.createSessionId(topic, resolvedRoot);

    const existing = this.sessions.get(sid);
    const tierSpec = TIERS[tier] || TIERS.standard;

    const hasSoftWarnings =
      validation.errors.length === 0 && validation.warnings.length > 0;
    const overrideCode = hasSoftWarnings
      ? `OVR-${randomBytes(2).toString("hex").toUpperCase()}`
      : null;

    const record = {
      sessionId: sid,
      state: existing?.state === "ACTIVE" ? "ACTIVE" : "STAGED",
      topic,
      scene: scene || "general",
      tier: tier || "standard",
      tierHistory: existing?.tierHistory || [tier || "standard"],
      goal: goal || "",
      roles,
      workspaceRoot: resolvedRoot,
      overrides: Array.isArray(overrides) ? overrides : [],
      hadUserModification:
        Boolean(existing?.hadUserModification) ||
        (Array.isArray(overrides) && overrides.length > 0),
      validation,
      seats: validation.seats,
      maxSubagentCalls: tierSpec.callCap,
      used: existing?.used || 0,
      inflight: existing?.inflight || 0,
      gateBlocks: existing?.gateBlocks || 0,
      gateOverrides: existing?.gateOverrides || 0,
      overrideCode,
      agentIds: existing?.agentIds || [],
      seq: existing?.seq || 0,
      eventsInitialized: Boolean(existing?.eventsInitialized),
      createdAt: existing?.createdAt || new Date().toISOString(),
    };

    this.sessions.set(sid, record);
    return record;
  }

  /**
   * 阶段二：用户确认披露卡后，将会话从 STAGED 跃迁为 ACTIVE（或处理中途升档）
   */
  activateSession({ sessionId, tier, overrideCode, workspaceRoot }) {
    const session = this.getSession(sessionId, workspaceRoot);
    if (!session) {
      throw new Error(
        `CABINET_SESSION_REQUIRED: 未找到会话 "${sessionId}"。请先调用 cabinet_start（不带 confirm:true）生成 STAGED 组阁披露卡。`
      );
    }

    if (workspaceRoot) {
      session.workspaceRoot = resolve(workspaceRoot);
    }

    // 1. 严禁绕过 Type E 硬错误
    if (session.validation.errors.length > 0) {
      session.gateBlocks += 1;
      throw new Error(
        `CABINET_PRINCIPLE_HARD_ERROR: 存在不可覆盖的 Type E 组阁错误，禁止激活会话：${session.validation.errors
          .map((e) => e.message)
          .join("；")}`
      );
    }

    // 2. 若存在 Type A-D 软警告，必须校验一次性 overrideCode
    if (session.validation.warnings.length > 0 && session.state !== "ACTIVE") {
      if (!overrideCode || overrideCode !== session.overrideCode) {
        session.gateBlocks += 1;
        throw new Error(
          `CABINET_OVERRIDE_REQUIRED: 当前配置触发了组阁原则软警告（${session.validation.warnings
            .map((w) => w.type)
            .join(", ")}）。若用户已知晓风险并坚持强制组阁，请传入一次性覆盖码 overrideCode="${session.overrideCode}"。`
        );
      }
      session.overrideCode = null; // 一次性消费
      session.gateOverrides += 1;
    }

    // 3. 如发生中途升档，切换预算硬顶
    if (tier && TIERS[tier] && tier !== session.tier) {
      const prevTier = session.tier;
      session.tier = tier;
      session.tierHistory.push(tier);
      session.maxSubagentCalls = TIERS[tier].callCap;
      if (session.eventsInitialized) {
        this.appendEvent(session, {
          phase: "upgrade",
          actor: "bridge",
          event: "cost:tier_upgrade",
          detail: `${prevTier} -> ${tier} (new cap=${session.maxSubagentCalls}, used=${session.used})`,
        });
      }
    }

    session.state = "ACTIVE";
    this.ensureEventsInitialized(session);
    this.appendEvent(session, {
      phase: "steering",
      actor: "user",
      event: "steering:cabinet_confirmed",
      detail: session.hadUserModification ? "改定后确认开议" : "确认默认配置开议",
    });

    return session;
  }

  ensureEventsInitialized(session) {
    if (session.eventsInitialized) return;
    const sessionDir = join(session.workspaceRoot, ".cabinet", session.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");

    if (!existsSync(eventsPath)) {
      const metaLine = {
        session_meta: true,
        session: session.sessionId,
        topic: session.topic,
        scene: session.scene,
        tier: session.tier,
        cap: session.maxSubagentCalls,
        t: new Date().toISOString(),
      };
      appendFileSync(eventsPath, JSON.stringify(metaLine) + "\n", "utf8");
    }
    session.eventsInitialized = true;

    this.appendEvent(session, {
      phase: "setup",
      actor: "bridge",
      event: "setup:disclosure_card_staged",
      detail: `seats=${session.seats.map((s) => `${s.seat}:${s.provider}/${s.rawModel}`).join(",")}`,
    });
  }

  /**
   * 单写者原子追加写入 events.jsonl
   * 注意：仅真实派发事件可使用 dispatch:spawn / dispatch:send_message 与 delegationId，以保证 audit.mjs 100% 精确对账
   */
  appendEvent(session, { phase, actor = "bridge", event, delegationId, detail }) {
    this.ensureEventsInitialized(session);
    const eventsPath = join(
      session.workspaceRoot,
      ".cabinet",
      session.sessionId,
      "events.jsonl"
    );
    session.seq += 1;
    const row = {
      seq: session.seq,
      t: new Date().toISOString(),
      phase: phase || "R1",
      actor,
      event,
      ...(delegationId ? { delegationId } : {}),
      ...(detail ? { detail } : {}),
    };
    appendFileSync(eventsPath, JSON.stringify(row) + "\n", "utf8");
    return row;
  }

  /**
   * 拦截 create_agent 与 send_agent_prompt：
   * 1) 强校验 ACTIVE 态 cabinetSessionId
   * 2) 同步预占 inflight 锁校验 maxSubagentCalls
   * 3) 注入只读 modeId 并清理 null thinkingOptionId
   * 4) 成功后在同一同步临界区扣减 inflight、累加 used、记录 agentId 并追加 dispatch:* 到 events.jsonl
   */
  async interceptSubagentCall(toolName, rawArgs, paseoClient) {
    const cabinetSessionId = rawArgs?.cabinetSessionId;
    if (!cabinetSessionId || typeof cabinetSessionId !== "string") {
      throw new Error(
        `CABINET_SESSION_REQUIRED: 调用 ${toolName} 必须提供 cabinetSessionId 参数（由 cabinet_start 签发）。`
      );
    }

    const session = this.getSession(cabinetSessionId, rawArgs?.cwd);
    if (!session) {
      throw new Error(
        `CABINET_SESSION_REQUIRED: 未知的 cabinetSessionId "${cabinetSessionId}"，请先调用 cabinet_start。`
      );
    }

    if (session.state === "STAGED") {
      session.gateBlocks += 1;
      throw new Error(
        `CABINET_SESSION_NOT_ACTIVE: 会话 "${cabinetSessionId}" 仍处于 STAGED 状态！你必须先向用户展示默认钉扎披露卡并用 ask_question 征得确认，再调用 cabinet_start({ sessionId: "${cabinetSessionId}", confirm: true }) 激活会话后才能派发阁员。`
      );
    }

    if (session.state === "CLOSED") {
      session.gateBlocks += 1;
      throw new Error(
        `CABINET_SESSION_CLOSED: 会话 "${cabinetSessionId}" 已闭合归档，禁止继续调用 ${toolName}。`
      );
    }

    // 同步预占锁检查预算硬顶
    if (session.used + session.inflight + 1 > session.maxSubagentCalls) {
      session.gateBlocks += 1;
      this.appendEvent(session, {
        phase: "cost",
        actor: "bridge",
        event: "cost:cap_hit",
        detail: `blocked ${toolName}: used=${session.used}, inflight=${session.inflight}, cap=${session.maxSubagentCalls}`,
      });
      throw new Error(
        `CABINET_BUDGET_EXCEEDED: 会话 "${cabinetSessionId}" 已达调用轨硬顶（${session.maxSubagentCalls} 次委派，已用 ${session.used} 次，在途 ${session.inflight} 次）。请立即停止派发，直接基于已有材料合议并输出议定书！`
      );
    }

    const upstreamArgs = structuredClone(rawArgs);
    delete upstreamArgs.cabinetSessionId;
    const waitForTurnComplete = Boolean(upstreamArgs.waitForTurnComplete);
    delete upstreamArgs.waitForTurnComplete;

    let baseProvider = "";
    let resolvedModel = "";

    if (toolName === "create_agent") {
      const rawProviderStr = String(upstreamArgs.provider || "").trim();
      const rawModelStr = String(upstreamArgs.model || "").trim();
      if (rawProviderStr.includes("/")) {
        const slashIdx = rawProviderStr.indexOf("/");
        baseProvider = rawProviderStr.slice(0, slashIdx);
        resolvedModel = rawModelStr || rawProviderStr.slice(slashIdx + 1);
        upstreamArgs.provider = rawProviderStr;
      } else {
        baseProvider = rawProviderStr;
        resolvedModel = rawModelStr;
        if (rawModelStr) {
          upstreamArgs.provider = `${rawProviderStr}/${rawModelStr}`;
        }
      }
      delete upstreamArgs.model;
      delete upstreamArgs.cwd;

      if (!upstreamArgs.title) {
        upstreamArgs.title = `Cabinet-${baseProvider || "agent"}`;
      }

      const readonlyMode = READONLY_MODE_BY_PROVIDER[baseProvider] || "plan";
      upstreamArgs.settings = {
        ...(upstreamArgs.settings || {}),
        modeId: readonlyMode,
      };
      // 若 thinkingOptionId 为空或 provider 为不支持 thinkingOptions 的 qwen-code，安全剔除该字段
      if (
        upstreamArgs.settings.thinkingOptionId === null ||
        upstreamArgs.settings.thinkingOptionId === undefined ||
        upstreamArgs.settings.thinkingOptionId === "" ||
        baseProvider === "qwen-code"
      ) {
        delete upstreamArgs.settings.thinkingOptionId;
      }
    }

    // 同步预占 inflight 槽位
    session.inflight += 1;
    try {
      const result = await paseoClient.callTool(toolName, upstreamArgs);
      // 同步提交临界区：扣减 inflight、累加 used、登记 agentId、落盘 dispatch 事件
      session.inflight -= 1;
      session.used += 1;
      const agentId = extractAgentIdFromMcpResult(
        result,
        upstreamArgs.agentId || `agent-${session.used}`
      );
      if (agentId && !session.agentIds.includes(agentId)) {
        session.agentIds.push(agentId);
      }

      const phase = session.used <= session.seats.length ? "R1" : "R2";
      const eventName =
        toolName === "create_agent" ? "dispatch:spawn" : "dispatch:send_message";
      const detail =
        toolName === "create_agent"
          ? `${baseProvider}/${resolvedModel} (call ${session.used}/${session.maxSubagentCalls})`
          : `prompt to ${agentId} (call ${session.used}/${session.maxSubagentCalls})`;

      this.appendEvent(session, {
        phase,
        actor: "bridge",
        event: eventName,
        delegationId: String(agentId),
        detail,
      });

      if (waitForTurnComplete && agentId && !String(agentId).startsWith("mock-agent-")) {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const stRes = await paseoClient.callTool("get_agent_status", { agentId });
            const stText = stRes?.content?.find((c) => typeof c?.text === "string")?.text || "";
            const stJson = stText.includes("{") ? JSON.parse(stText.slice(stText.indexOf("{"))) : {};
            if (stJson.status && stJson.status !== "running") {
              break;
            }
          } catch {
            break;
          }
        }
        try {
          const actRes = await paseoClient.callTool("get_agent_activity", { agentId, limit: 50 });
          const actText = actRes?.content?.find((c) => typeof c?.text === "string")?.text || "";
          if (actText && Array.isArray(result?.content)) {
            result.content.push({ type: "text", text: `\n--- Agent Activity ---\n${actText}` });
          }
        } catch {
          // ignore activity fetch failure
        }
      }

      return result;
    } catch (err) {
      session.inflight -= 1;
      this.appendEvent(session, {
        phase: "R1",
        actor: "bridge",
        event: "error:upstream_dispatch_failed",
        detail: `${toolName} failed: ${err.message}`,
      });
      throw err;
    }
  }
}
