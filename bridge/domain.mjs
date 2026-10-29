import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");

const CABINET_HOME = resolve(process.env.CABINET_HOME || join(homedir(), "dsh-cabinet"));
const pkgPath = join(CABINET_HOME, "package.json");
if (!existsSync(pkgPath)) {
  throw new Error(`[paseo-cabinet] 找不到 dsh-cabinet 仓库: ${pkgPath}`);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const EXPECTED_VERSION_PREFIX = "0.2.";
if (!String(pkg.version || "").startsWith(EXPECTED_VERSION_PREFIX)) {
  throw new Error(
    `[paseo-cabinet] CABINET_HOME 版本漂移: 期望 ${EXPECTED_VERSION_PREFIX}x，实测 ${pkg.version}`
  );
}

const coreUrl = pathToFileURL(join(CABINET_HOME, "lib/index.js")).href;
const core = await import(coreUrl);

export const {
  TIERS,
  SCENE_ROLE_PACKS,
  MINISTER_NAMES,
  SEAT_MAPPING,
  CONTINUATION_ENABLED,
  MECHANISMS,
  checkSeatDimensions,
  stripFrontmatter,
  parseFrontmatterMeta,
  loadMinisters,
  loadSkills,
  normalizePinning,
  normalizePool,
  buildInstruction,
} = core;

export { CABINET_HOME };

export const FAMILY_ALIASES = {
  kimi: "moonshot",
  "kimi-coding": "moonshot",
  "kimi-for-coding": "moonshot",
  "qwen-code": "qwen",
  "qwen-token-plan-cn": "qwen",
  "glm-acp-agent": "zhipu",
  "zai-coding-cn": "zhipu",
  "zai-coding-plan": "zhipu",
  opencode: "deepseek",
  "deepseek-account": "deepseek",
  google: "google",
  anthropic: "anthropic",
};

/**
 * 归一化模型家族：优先按 model 字符串识别底层模型真实厂商（防止跨 CLI 挂载同源模型绕过异源门禁），
 * 未命中时再回退到 provider 映射表。
 */
export function canonicalModelFamily(provider, model = "") {
  const m = String(model || "").trim().toLowerCase();
  if (m.includes("glm") || m.includes("zhipu")) return "zhipu";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") || m.includes("coder-model")) return "qwen";
  if (m.includes("kimi") || /\bk3\b|\bk2\b/.test(m)) return "moonshot";
  if (m.includes("gemini") || m.includes("google")) return "google";
  if (m.includes("claude") || m.includes("anthropic")) return "anthropic";

  const p = String(provider || "").trim().toLowerCase();
  const raw = p.includes("/") ? p.split("/")[0] : p;
  return FAMILY_ALIASES[raw] || raw;
}

/**
 * 八阁员的人格气质与默认立场维度表（补齐 dsh-cabinet loadMinisters 剥离 frontmatter 后缺失的维度字段）
 */
export const MINISTER_META = {
  feng: {
    key: "feng",
    shortName: "锋",
    name: MINISTER_NAMES.feng,
    temperament: "攻击/红队批判",
    defaultStance: "默认共识是错的，直到经受住最严苛的反驳",
    cognitiveTier: "flagship",
  },
  yuan: {
    key: "yuan",
    shortName: "远",
    name: MINISTER_NAMES.yuan,
    temperament: "长期/反折中演化",
    defaultStance: "为三年后的系统与作品代言，反对无原则折中",
    cognitiveTier: "flagship",
  },
  li: {
    key: "li",
    shortName: "立",
    name: MINISTER_NAMES.li,
    temperament: "建设/钢铁人辩护",
    defaultStance: "为主流主张构造最强钢铁人论证并主动交出最弱一环",
    cognitiveTier: "flagship",
  },
  shen: {
    key: "shen",
    shortName: "审",
    name: MINISTER_NAMES.shen,
    temperament: "方法审查/程序正义",
    defaultStance: "结论对错先放一边，论证方式违法就是无效",
    cognitiveTier: "fast-high-thinking",
  },
  ju: {
    key: "ju",
    shortName: "据",
    name: MINISTER_NAMES.ju,
    temperament: "证据核查/信源洁癖",
    defaultStance: "无证据不发言，同一事实出自不同信源是两个事实",
    cognitiveTier: "fast",
  },
  mou: {
    key: "mou",
    shortName: "谋",
    name: MINISTER_NAMES.mou,
    temperament: "落地执行/砍半预算",
    defaultStance: "能跑的平庸方案胜过完美的纸上架构",
    cognitiveTier: "fast",
  },
  zhong: {
    key: "zhong",
    shortName: "众",
    name: MINISTER_NAMES.zhong,
    temperament: "读者体感/第一反应",
    defaultStance: "作者觉得好不算数，读者划走只要三秒",
    cognitiveTier: "fast",
  },
  gu: {
    key: "gu",
    shortName: "骨",
    name: MINISTER_NAMES.gu,
    temperament: "叙事骨架/节奏控制",
    defaultStance: "读者不是被内容留住的，是被下一个段落留住的",
    cognitiveTier: "fast",
  },
};

/**
 * 各场景角色包的席位投射定义（按档位取前 N 席：standard=4, advanced=5, max=6）
 */
export const SCENE_SEAT_TEMPLATES = {
  coding: [
    {
      seat: "红队批判官",
      preferredMinister: "feng",
      stance: "默认共识是错的，攻击全体共识中最脆弱的假设",
      isRedTeam: true,
      highCognition: true,
    },
    {
      seat: "架构官",
      preferredMinister: "yuan",
      stance: "为三年后的系统代言，评估耦合、演化性与边界清晰度",
      isRedTeam: false,
      highCognition: true,
    },
    {
      seat: "工程官",
      preferredMinister: "mou",
      stance: "能跑的平庸方案胜过完美的纸上架构，关注落地与回滚",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "成本官",
      preferredMinister: "zhong",
      stance: "最贵的方案常常看起来最便宜，算总账并寻找砍半预算版本",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "信源核查官",
      preferredMinister: "ju",
      stance: "核查代码与文档事实依据，追溯到可核验的最近点",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "方法审查官",
      preferredMinister: "shen",
      stance: "审查技术推演的方法有效性与隐含前提跳跃",
      isRedTeam: false,
      highCognition: true,
    },
  ],
  writing: [
    {
      seat: "红队批判官",
      preferredMinister: "feng",
      stance: "默认共识是错的，攻击全体共识中最脆弱的假设",
      isRedTeam: true,
      highCognition: true,
    },
    {
      seat: "立意官",
      preferredMinister: "yuan",
      stance: "平庸的立意再好的文笔也救不回来，追求锐度与差异化",
      isRedTeam: false,
      highCognition: true,
    },
    {
      seat: "结构官",
      preferredMinister: "gu",
      stance: "读者是被下一个段落留住的，只管骨架、节奏与弃文点",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "读者代理",
      preferredMinister: "zhong",
      stance: "作者觉得好不算数，读者划走只要三秒，拒绝术语",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "事实核查官",
      preferredMinister: "ju",
      stance: "一个硬伤足以摧毁读者对全文的信任，较真每一处事实",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "方法审查官",
      preferredMinister: "shen",
      stance: "审查文章论证链条的形式有效性与因果跳跃",
      isRedTeam: false,
      highCognition: true,
    },
  ],
  research: [
    {
      seat: "红队批判官",
      preferredMinister: "feng",
      stance: "默认共识是错的，专门审查议事本身最脆弱的假设",
      isRedTeam: true,
      highCognition: true,
    },
    {
      seat: "正方",
      preferredMinister: "li",
      stance: "为主流倾向构造最强钢铁人支持论证并主动交出最弱一环",
      isRedTeam: false,
      highCognition: true,
    },
    {
      seat: "反方",
      preferredMinister: "yuan", // 锋已被红队占用，默认调长期席/征召异源高配模型担任反方
      stance: "对正方构造最强反驳，寻找反例、替代解释与被忽略代价",
      isRedTeam: false,
      highCognition: true,
    },
    {
      seat: "方法审查官",
      preferredMinister: "shen",
      stance: "结论对错先放一边，论证方式违法就是无效",
      isRedTeam: false,
      highCognition: true,
    },
    {
      seat: "信源核查官",
      preferredMinister: "ju",
      stance: "同一个事实出自不同信源是两个事实，严格分级信源",
      isRedTeam: false,
      highCognition: false,
    },
    {
      seat: "成本官 / 读者代理",
      preferredMinister: "zhong",
      stance: "从受众体感与现实落地代价审视研究结论",
      isRedTeam: false,
      highCognition: false,
    },
  ],
};
SCENE_SEAT_TEMPLATES.general = SCENE_SEAT_TEMPLATES.research;

/**
 * 加载插件的 config/ministers.json
 */
export function loadMinistersConfig(configPath) {
  const candidate = configPath || process.env.CABINET_MINISTERS_CONFIG;
  const resolved =
    candidate && existsSync(resolve(candidate))
      ? resolve(candidate)
      : join(PLUGIN_ROOT, "config", "ministers.json");
  return JSON.parse(readFileSync(resolved, "utf8"));
}

/**
 * 将 ministers.json 转为 dsh-cabinet buildInstruction 所需的 pinning 与 pool 格式
 */
export function toDshPinningAndPool(ministersConfig, overrides = []) {
  const mergedMinisters = structuredClone(ministersConfig.ministers || {});
  if (Array.isArray(overrides)) {
    for (const ov of overrides) {
      if (ov && ov.minister && mergedMinisters[ov.minister]) {
        if (ov.provider) mergedMinisters[ov.minister].provider = ov.provider;
        if (ov.model) mergedMinisters[ov.minister].model = ov.model;
        if ("thinkingOptionId" in ov) {
          mergedMinisters[ov.minister].thinkingOptionId = ov.thinkingOptionId;
        }
      }
    }
  }

  const dshPinning = {};
  for (const [k, v] of Object.entries(mergedMinisters)) {
    if (v && v.provider && v.model) {
      dshPinning[k] = {
        provider: v.provider,
        model: v.model,
        ...(v.thinkingOptionId ? { reasoningEffort: v.thinkingOptionId } : {}),
      };
    }
  }

  const dshPool = (ministersConfig.pool || []).map((p) => ({
    provider: p.provider,
    model: p.model,
    ...(p.thinkingOptionId ? { reasoningEffort: p.thinkingOptionId } : {}),
  }));

  return { mergedMinisters, dshPinning, dshPool };
}

/**
 * 计算当场激活席位的完整列表（含 temperament、stance、family，供 checkSeatDimensions 及披露卡使用）
 */
export function resolveSceneSeats({
  scene = "general",
  tier = "standard",
  ministersConfig,
  overrides = [],
  customRoles = null,
}) {
  const t = TIERS[tier] || TIERS.standard;
  const sceneKey = SCENE_SEAT_TEMPLATES[scene] ? scene : "general";
  const templates = SCENE_SEAT_TEMPLATES[sceneKey];
  const { mergedMinisters } = toDshPinningAndPool(ministersConfig, overrides);

  let selectedTemplates = templates.slice(0, t.seats);
  if (Array.isArray(customRoles) && customRoles.length > 0) {
    const customList = [];
    // 红队批判官必须保留在第一席
    customList.push(templates[0]);
    for (const roleName of customRoles) {
      if (roleName.includes("红队")) continue;
      const matched =
        templates.find((tpl) => tpl.seat === roleName || roleName.includes(tpl.seat)) || {
          seat: roleName,
          preferredMinister: "ju",
          stance: `围绕「${roleName}」视角独立审视议题`,
          isRedTeam: false,
          highCognition: false,
        };
      customList.push(matched);
    }
    selectedTemplates = customList.slice(0, t.seats);
  }

  const seats = selectedTemplates.map((tpl) => {
    // 检查是否有针对 seat 名称或 minister 键的特定 override
    const seatOverride = Array.isArray(overrides)
      ? overrides.find(
          (ov) =>
            (ov.seat && ov.seat === tpl.seat) ||
            (ov.minister && ov.minister === tpl.preferredMinister && !ov.seat)
        )
      : null;

    const ministerKey = seatOverride?.minister || tpl.preferredMinister;
    const meta = MINISTER_META[ministerKey] || {
      key: ministerKey,
      shortName: ministerKey,
      name: MINISTER_NAMES[ministerKey] || ministerKey,
      temperament: `专职/${ministerKey}`,
      defaultStance: tpl.stance,
      cognitiveTier: "fast",
    };

    const pin = mergedMinisters[ministerKey] || {};
    const provider = seatOverride?.provider || pin.provider || "glm-acp-agent";
    const rawModel = seatOverride?.model || pin.model || "glm-5.3";
    const thinkingOptionId =
      seatOverride && "thinkingOptionId" in seatOverride
        ? seatOverride.thinkingOptionId
        : pin.thinkingOptionId ?? null;

    const family = canonicalModelFamily(provider, rawModel);

    return {
      seat: tpl.seat,
      minister: ministerKey,
      ministerName: meta.name,
      temperament: meta.temperament,
      stance: tpl.stance || meta.defaultStance,
      provider,
      rawModel,
      // 供 dsh-cabinet checkSeatDimensions(seats, sessionModel) 的 modelFamily() 取斜杠前字段
      model: `${family}/${rawModel}`,
      family,
      thinkingOptionId,
      isRedTeam: Boolean(tpl.isRedTeam),
      highCognition: Boolean(tpl.highCognition),
    };
  });

  return seats;
}

/**
 * 执行五类组阁原则预检（Type A - Type E）
 */
export function validateCabinetPrinciples({
  scene = "general",
  tier = "standard",
  ministersConfig,
  overrides = [],
  customRoles = null,
}) {
  const leadFamily = canonicalModelFamily(ministersConfig.leadModelFamily || "google");
  const allowedModels = ministersConfig.allowedModels || [];
  const seats = resolveSceneSeats({ scene, tier, ministersConfig, overrides, customRoles });

  const errors = []; // Type E 硬错误（不可用/不在白名单/档位非法），禁止签发 overrideCode
  const warnings = []; // Type A-D 软警告（违背组阁原则），可签发一次性 overrideCode

  // 1. Type E 检查：逐席核对 provider + rawModel + thinkingOptionId 是否在 allowedModels 白名单中
  for (const s of seats) {
    const matchedModel = allowedModels.find(
      (m) => m.provider === s.provider && m.model === s.rawModel
    );
    if (!matchedModel) {
      const validList = allowedModels.map((m) => `${m.provider}/${m.model}`).join(", ");
      errors.push({
        type: "Type E (白名单/目录越界)",
        seat: s.seat,
        minister: s.minister,
        message: `席位「${s.seat}（${s.ministerName}）」指定的路由 ${s.provider} / ${s.rawModel} 不在当前允许的 5 模型白名单内。合法路由：${validList}`,
      });
      continue;
    }

    if (matchedModel.thinkingOptions === null) {
      if (s.thinkingOptionId !== null && s.thinkingOptionId !== undefined && s.thinkingOptionId !== "") {
        errors.push({
          type: "Type E (思考档位不支持)",
          seat: s.seat,
          minister: s.minister,
          message: `席位「${s.seat}」使用的模型 ${s.provider}/${s.rawModel} 在 Paseo 中不支持思考强度参数（thinkingOptions: null），请将 thinkingOptionId 设为 null。`,
        });
      }
    } else if (Array.isArray(matchedModel.thinkingOptions)) {
      if (
        s.thinkingOptionId !== null &&
        s.thinkingOptionId !== undefined &&
        !matchedModel.thinkingOptions.includes(s.thinkingOptionId)
      ) {
        errors.push({
          type: "Type E (思考档位越界)",
          seat: s.seat,
          minister: s.minister,
          message: `席位「${s.seat}」的模型 ${s.provider}/${s.rawModel} 不支持思考档位 "${s.thinkingOptionId}"。该模型合法档位：[${matchedModel.thinkingOptions.join(", ")}]`,
        });
      }
    }
  }

  // 2. 调用 dsh-cabinet 原生 checkSeatDimensions 检查三维不重合与红队异源（Type A & Type B）
  const dimResult = checkSeatDimensions(seats, leadFamily);
  if (!dimResult.pass) {
    for (const f of dimResult.failures) {
      if (f.includes("红队")) {
        warnings.push({
          type: "Type A (红队异源铁律违背)",
          message: `${f}（当前红队家族=${seats.find((s) => s.isRedTeam)?.family}，宿主家族=${leadFamily}）。建议将红队「锋」改为 kimi/kimi-code/k3.1-pro 或 qwen-code/qwen3.8-max(openai)。`,
        });
      } else {
        warnings.push({
          type: "Type B (三维不重合失败/同质化退化)",
          message: `${f}。建议确保在场席位至少包含 2 个不同底层模型家族（moonshot / qwen / zhipu / deepseek）。`,
        });
      }
    }
  }

  // 3. Type C 检查：高认知席位（红队/架构官/立意官/正方/反方/方法审查官）降配为 flash 且低思考强度
  for (const s of seats) {
    if (!s.highCognition) continue;
    const isFlash = s.rawModel.toLowerCase().includes("flash");
    const isLowThinking = ["none", "minimal", "low"].includes(String(s.thinkingOptionId || "").toLowerCase());
    if (isFlash && isLowThinking) {
      warnings.push({
        type: "Type C (高认知席位严重降配)",
        seat: s.seat,
        minister: s.minister,
        message: `高认知负重席位「${s.seat}（${s.ministerName}）」被分配了轻量级 Flash 模型（${s.rawModel}）且思考强度为低档（${s.thinkingOptionId}），极易导致论证深度坍塌。建议改用旗舰模型（k3.1-pro / qwen3.8-max / glm-5.3）或将思考强度调至 high/max。`,
      });
    }
  }

  // 4. Type D 检查：同一阁员同场兼任多席
  const ministerCounts = new Map();
  for (const s of seats) {
    ministerCounts.set(s.minister, (ministerCounts.get(s.minister) || 0) + 1);
  }
  for (const [mKey, count] of ministerCounts.entries()) {
    if (count > 1) {
      warnings.push({
        type: "Type D (同一阁员兼任多席)",
        minister: mKey,
        message: `阁员「${MINISTER_NAMES[mKey] || mKey}」在本场同时兼任了 ${count} 个席位，违背“同一阁员同场不兼任两席”原则。建议将其余席位改派未在场阁员（如据/众/审/立）。`,
      });
    }
  }

  return {
    pass: errors.length === 0 && warnings.length === 0,
    seats,
    dimResult,
    errors,
    warnings,
  };
}

/**
 * 渲染 P9 组阁前默认钉扎披露卡（供阶段一返回给 Lead 展示给用户）
 */
export function renderPreCabinetDisclosureCard({
  sessionId,
  topic,
  scene,
  tier,
  seats,
  ministersConfig,
  dimResult,
  errors,
  warnings,
  overrideCode,
}) {
  const t = TIERS[tier] || TIERS.standard;
  const seatRows = seats
    .map(
      (s, idx) =>
        `| ${idx + 1} | **${s.seat}**${s.isRedTeam ? " (固定席)" : ""} | ${s.ministerName} (\`${s.minister}\`) | \`${s.provider}\` | \`${s.rawModel}\` | \`${s.thinkingOptionId ?? "null (默认)"}\` | \`${s.family}\` |`
    )
    .join("\n");

  const allMinistersRows = Object.entries(ministersConfig.ministers || {})
    .map(
      ([k, v]) =>
        `| \`${k}\` | ${MINISTER_NAMES[k] || k} | ${v.role || ""} | \`${v.provider}\` | \`${v.model}\` | \`${v.thinkingOptionId ?? "null"}\` |`
    )
    .join("\n");

  const allowedRows = (ministersConfig.allowedModels || [])
    .map(
      (m) =>
        `| \`${m.provider}\` | \`${m.model}\` | \`${m.family}\` | ${m.thinkingOptions ? m.thinkingOptions.map((o) => `\`${o}\``).join(", ") : "`null` (无档位参数)"} | \`${m.readonlyModeId}\` |`
    )
    .join("\n");

  const familySet = new Set(seats.map((s) => s.family));
  const checkSummary = dimResult.pass
    ? `PASS（覆盖 ${familySet.size} 个独立模型家族：${[...familySet].join(", ")}；红队异源校验通过）`
    : `FAIL（${dimResult.failures.join("；")}）`;

  const alertBlocks = [];
  if (errors.length > 0) {
    alertBlocks.push(
      `### ❌ 组阁硬性拦截（Type E 物理/目录越界，不可强制覆盖）\n` +
        errors.map((e, i) => `${i + 1}. **[${e.type}]** ${e.message}`).join("\n")
    );
  }
  if (warnings.length > 0) {
    alertBlocks.push(
      `### ⚠️ 违背组阁原则提醒（Type A–D 软警告）\n` +
        warnings.map((w, i) => `${i + 1}. **[${w.type}]** ${w.message}`).join("\n") +
        (overrideCode
          ? `\n\n> **误拦恢复 / 强制组阁口令**：若用户确认知晓上述退化风险并坚持按此配置开议，请再次调用 \`cabinet_start({ sessionId: "${sessionId}", confirm: true, overrideCode: "${overrideCode}" })\` 放行（单次有效，记入 \`gate_overrides\`）。`
          : "")
    );
  }

  return [
    `## 🏛️ 内阁组阁前默认钉扎披露卡（待用户确认）`,
    ``,
    `- **会话 ID (\`cabinetSessionId\`)**：\`${sessionId}\`（当前状态：\`STAGED\`，未确认前 \`create_agent\` 已锁定）`,
    `- **审议议题**：${topic}`,
    `- **场景角色包**：\`${scene || "general"}\` ｜ **档位**：\`${tier || "standard"}\`（${t.seats} 席 × ${t.rounds} 轮，硬顶上限 **${t.callCap} 次委派**）`,
    `- **三维异质性与红队异源预检**：${checkSummary}`,
    ``,
    `### 一、本场拟上场席位配置（共 ${seats.length} 席）`,
    ``,
    `| 序 | 席位 | 映射阁员 | CLI (\`provider\`) | 模型 (\`model\`) | 思考强度 (\`thinkingOptionId\`) | 模型家族 |`,
    `|---|---|---|---|---|---|---|`,
    seatRows,
    ``,
    `### 二、八阁员完整默认钉扎表（可按席位或阁员键改定）`,
    ``,
    `| 阁员键 | 阁员名 | 专职定位 | 默认 CLI | 默认模型 | 默认思考强度 |`,
    `|---|---|---|---|---|---|`,
    allMinistersRows,
    ``,
    `### 三、本机可用 CLI / 模型 / 思考强度白名单对照表`,
    ``,
    `| CLI (\`provider\`) | 模型 (\`model\`) | 底层家族 | 可选思考强度 (\`thinkingOptions\`) | 注入只读模式 |`,
    `|---|---|---|---|---|`,
    allowedRows,
    ``,
    ...(alertBlocks.length > 0 ? [alertBlocks.join("\n\n"), ``] : []),
    `---`,
    `### 下一步操作规程（Lead 必读）`,
    `1. **必须先向用户完整展示上表**，并使用 \`ask_question\` 征询用户意见：`,
    `   - 选项 1：**确认当前配置，正式组阁开议**`,
    `   - 选项 2：**修改阁员配置（CLI / 模型 / 思考强度）**`,
    `   - 选项 3：**取消组阁（散会）**`,
    `2. 若用户选择「确认当前配置」（且无 Type E 错误）：调用 \`cabinet_start({ sessionId: "${sessionId}", confirm: true })\` 将会话激活为 \`ACTIVE\`，获取完整议事编排计划后派发 R1。`,
    `3. 若用户提出修改（如“把架构官换 glm-5.3 high”）：调用 \`cabinet_start({ sessionId: "${sessionId}", topic: ${JSON.stringify(topic)}, scene: "${scene || "general"}", tier: "${tier || "standard"}", overrides: [{ seat: "架构官", provider: "glm-acp-agent", model: "glm-5.3", thinkingOptionId: "high" }] })\` 重新预检并向用户展示更新后的披露卡（如有违背组阁原则须提醒用户）。`,
  ].join("\n");
}

/**
 * 将 dsh-cabinet buildInstruction() 产出的原生计划文本改写为 Paseo + Antigravity 契约文本，
 * 附带严格匹配断言，防止上游文本变化导致静默失配。
 */
export function adaptInstructionForPaseo(rawText, { sessionId = "<sessionId>", seats = [] } = {}) {
  let out = String(rawText);

  const replacements = [
    {
      name: "list_subagent_models -> list_providers/list_models",
      pattern: /list_subagent_models/g,
      replacement: "list_providers 与 list_models",
    },
    {
      name: "ask_user_question -> ask_question",
      pattern: /ask_user_question/g,
      replacement: "ask_question",
    },
    {
      name: "R1 subagent dispatch instruction -> Paseo create_agent",
      pattern: /每个 subagent 委派（run_in_background: true 并发派发，随后以完成通知\r?\n收齐）的 prompt 必须包含：/g,
      replacement: `每个阁员席位通过 paseo-cabinet 的 \`create_agent\` 派发（**必须传入 \`cabinetSessionId: "${sessionId}"\`**，网关自动注入只读 \`settings.modeId\` 与 \`settings.thinkingOptionId\`；可并行调用或配合 \`get_agent_status\` 收齐），其 \`initialPrompt\` 必须包含：`,
    },
    {
      name: "delegation parameters -> create_agent parameters",
      pattern: /在委派参数 provider\/model\/reasoning_effort 中下发/g,
      replacement: `在 \`create_agent\` 参数 \`provider\` / \`model\` / \`settings.thinkingOptionId\` 中下发（同时必传 \`cabinetSessionId: "${sessionId}"\`）`,
    },
    {
      name: "events.jsonl single-writer protection",
      pattern: /├── events\.jsonl[\s\S]*?对账 cost\.calls）；②送达——每轮收齐核对；③预算——升档切换、触顶中止、成本决算/g,
      replacement: `├── events.jsonl    # 【单写者保护】由 paseo-cabinet 桥接网关在拦截 create_agent / send_agent_prompt 及会话生命周期时自动原子追加写入（含 session_meta 与 dispatch:spawn / dispatch:send_message）；严禁使用 write_file 或 edit_file 手动创建或覆写 events.jsonl！`,
    },
    {
      name: "audit.mjs -> cabinet_audit tool",
      pattern: /归档后跑一次 node scripts\/audit\.mjs，\r?\n把结论写入。/g,
      replacement: `归档写入 round-N.jsonl 与 protocol.json 后，**必须调用 \`cabinet_audit({ cabinetSessionId: "${sessionId}", workspaceRoot: "<项目工作区绝对路径>" })\`** 完成机器对账、自动追加写入 index.jsonl 并自动销毁本场全部 Paseo 阁员进程。`,
    },
    {
      name: "archive directory sessionId binding",
      pattern: /<时间戳>-<slug>/g,
      replacement: sessionId,
    },
  ];

  for (const rule of replacements) {
    if (!rule.pattern.test(out)) {
      throw new Error(
        `[paseo-cabinet] adaptInstructionForPaseo 契约断言失败：未能在 buildInstruction 输出中匹配规则 "${rule.name}"`
      );
    }
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }

  // 替换残留的 send_message 工具指代
  out = out.replace(/\bsend_message\b/g, "send_agent_prompt");

  if (out.includes("list_subagent_models") || out.includes("ask_user_question")) {
    throw new Error("[paseo-cabinet] adaptInstructionForPaseo 存在未清理干净的 DSH 专属工具名");
  }

  // 在计划头部追加已锁定的本场席位路由速查表，确保 Lead 派发 create_agent 时参数 100% 精确
  if (Array.isArray(seats) && seats.length > 0) {
    const lockedTable = [
      ``,
      `### 📌 本场已确认激活的 Paseo 阁员派发参数表（\`cabinetSessionId: "${sessionId}"\`）`,
      ``,
      `| 席位 | 阁员 | \`provider\` | \`model\` | \`settings.thinkingOptionId\` |`,
      `|---|---|---|---|---|`,
      ...seats.map(
        (s) =>
          `| ${s.seat} | ${s.ministerName} (\`${s.minister}\`) | \`${s.provider}\` | \`${s.rawModel}\` | ${s.thinkingOptionId ? `\`"${s.thinkingOptionId}"\`` : "省略（传 `{}`）"} |`
      ),
      ``,
      `> **注意**：由于你在调用 \`cabinet_start(confirm: true)\` 前已完成第 0.5 步组阁披露与用户确认，请直接跳过下文第 0.5 步的重复提问，立即按上表并发调用 \`create_agent\` 启动第 1 步（R1 独立立场书）！`,
      ``,
    ].join("\n");
    out = lockedTable + "\n" + out;
  }

  return out;
}

/**
 * 启动期值级 Canary 自检（P3）
 */
export function runStartupCanary(ministersConfig) {
  // 断言 1：同质退化名单必须返回 pass: false
  const badCheck = checkSeatDimensions(
    [
      { seat: "红队批判官", temperament: "t", stance: "s", model: "zhipu/glm-5.3", isRedTeam: true },
      { seat: "架构官", temperament: "t", stance: "s", model: "zhipu/glm-5.3" },
    ],
    "zhipu"
  );
  if (badCheck.pass !== false || badCheck.failures.length < 3) {
    throw new Error("[paseo-cabinet] Canary 失败：checkSeatDimensions 未能拦截全同质退化组阁");
  }

  // 断言 2：默认 coding 场景席位必须通过三维不重合检查
  const defaultValidation = validateCabinetPrinciples({
    scene: "coding",
    tier: "standard",
    ministersConfig,
  });
  if (!defaultValidation.pass) {
    throw new Error(
      `[paseo-cabinet] Canary 失败：默认 coding 钉扎未能通过组阁原则检查: ${JSON.stringify({
        errors: defaultValidation.errors,
        warnings: defaultValidation.warnings,
      })}`
    );
  }

  // 断言 3：buildInstruction + adaptInstructionForPaseo 转换必须零异常通过
  const ministers = loadMinisters();
  const { dshPinning, dshPool } = toDshPinningAndPool(ministersConfig);
  const rawPlan = buildInstruction({
    topic: "Canary 自检议题",
    scene: "coding",
    tier: "standard",
    ministers,
    pinning: dshPinning,
    pool: dshPool,
  });
  const adapted = adaptInstructionForPaseo(rawPlan, {
    sessionId: "2026-10-28-canary-test",
    seats: defaultValidation.seats,
  });
  if (!adapted.includes("cabinet_audit") || !adapted.includes("单写者保护")) {
    throw new Error("[paseo-cabinet] Canary 失败：adaptInstructionForPaseo 转换结果缺失关键锚点");
  }

  return {
    ok: true,
    dshCabinetVersion: pkg.version,
    ministersCount: ministers.length,
  };
}
