# Paseo Cabinet (`paseo-cabinet`)

基于 **[pertboem-ops/dsh-cabinet](https://github.com/pertboem-ops/dsh-cabinet) (`v0.2.6`)** 与 **[getpaseo/paseo](https://github.com/getpaseo/paseo)** ACP 多智能体守护进程构建的 **Google Antigravity 异构多模型内阁议事插件**。

在单智能体难以决断的高代价场景（技术架构选型、复杂议题正反论证、长篇创作立意与大纲评审）中，由 **Google Antigravity** 担任内阁首辅（Lead Orchestrator），通过本地 **Paseo Daemon** 并发调度 Kimi Code、Qwen Code、GLM Agent、OpenCode (DeepSeek) 等多厂商异构 CLI 阁员，完成**组阁披露确认 → R1 独立立论 → R1 两栏速览停等 → R2 交叉质询 → 合议定案与机器对账归档**的完整闭环。

---

## 核心架构与工程特性

1. **真异构多厂商内阁（零宿主同源退化）**
   - 宿主 Lead（Antigravity）仅负责主持与合议，八席专职阁员（`锋`、`远`、`立`、`审`、`据`、`谋`、`众`、`骨`）通过 Paseo 跨进程调度宿主机已安装的独立 CLI Coding Agents。
   - 内置 `canonicalModelFamily(provider, model)` 模型特征优先识别器，即使同一模型被挂载在不同 CLI 下也能精确识别底层厂商（`moonshot` / `qwen` / `zhipu` / `deepseek` / `google`），杜绝“异名同源”绕过三维异质性门禁。

2. **三态会话令牌 (`STAGED → ACTIVE → CLOSED`) 与 P9 组阁前交互确认**
   - **阶段 1（`STAGED`）**：调用 `cabinet_start`（不传 `confirm: true`）生成 `STAGED` 态令牌与《组阁前默认钉扎披露卡》（展示当场席位、八阁员完整钉扎表、白名单模型及 `thinkingOptions` 对照表）。在 `STAGED` 状态下调用 `create_agent` 会被网关直接拦截（`CABINET_SESSION_NOT_ACTIVE`），从代码层防止宿主在自动执行模式下跳过用户确认抢跑建阁。
   - **Type A–E 组阁原则预检**：支持用户在开议前任意改定席位的 CLI (`provider`)、模型 (`model`) 与思考强度 (`thinkingOptionId`)。网关自动执行五类组阁原则预检：
     - **Type A**：红队批判官与宿主同源告警
     - **Type B**：三维（气质/立场/模型家族）全重合或单源退化告警
     - **Type C**：高认知负重席位（红队/架构/立意/正反方）降配为 Flash + 低思考档位告警
     - **Type D**：同一阁员同场兼任多席告警
     - **Type E**：物理越界或不支持的 `thinkingOptionId` 硬错误（**绝对禁止覆盖**；Type A–D 软警告签发一次性覆盖码 `OVR-XXXX`，记入 `gate_overrides`）
   - **阶段 2（`ACTIVE`）**：用户确认后调用 `cabinet_start({ sessionId, confirm: true })` 激活会话，解锁 `create_agent` 并下发适配 Paseo 的完整编排计划。

3. **`inflight` 并发预占预算锁与 `events.jsonl` 单一写入者**
   - 严格执行三档调用硬顶（`standard = 9`、`advanced = 16`、`max = 19`）。转发前同步执行 `inflight += 1` 预占槽位，防止 `Promise.all` 并发派发击穿上限。
   - `.cabinet/<sessionId>/events.jsonl` 由网关在拦截 `create_agent` / `send_agent_prompt` 时**唯一原子追加写入**（通过 `adaptInstructionForPaseo()` 剥离宿主自写 `events.jsonl` 指令），彻底消除双写竞争与审计计数翻倍问题。
   - 网关层收敛为 **9 工具白名单**，剔除 `set_agent_mode`，在 `create_agent` 内部按 Provider 自动注入只读模式（`kimi` / `qwen-code` / `opencode` 注入 `"plan"`，`glm-acp-agent` 注入 `"default"`）。

4. **五步闭环审计 (`cabinet_audit`)**
   - 议事收尾时调用 `cabinet_audit`，网关自动执行：① 核验 `round-1.jsonl` / `protocol.json` / `events.jsonl` 非空 → ② 写入 `cost:final` 决算事件 → ③ 调用 `dsh-cabinet/scripts/audit.mjs` 并按 `^<sessionId>: ok calls=(\d+)` 精确匹配当场对账结果 → ④ 追加写入 `.cabinet/index.jsonl` → ⑤ 自动调用 `delete_agent` 回收本场全部 Paseo 阁员进程并将会话置为 `CLOSED`。

---

## 目录结构

```text
paseo-cabinet/
├── plugin.json                  # Antigravity 插件清单
├── package.json                 # ESM 包定义与构建/测试脚本
├── mcp_config.template.json     # MCP 服务配置模板（由 setup.mjs 渲染生成 mcp_config.json）
├── assets/
│   └── logo.svg                 # 插件图标
├── config/
│   └── ministers.json           # 白名单模型目录、八阁员默认钉扎表与候选池配置
├── rules/
│   └── AGENTS.md                # 内阁首辅（Lead）议事行为纪律
├── skills/                      # 由 setup.mjs 从 dsh-cabinet 转换生成的四大技能
│   ├── cabinet/SKILL.md
│   ├── cabinet-roles-coding/SKILL.md
│   ├── cabinet-roles-writing/SKILL.md
│   └── cabinet-roles-research/SKILL.md
├── bridge/
│   ├── domain.mjs               # dsh-cabinet 纯函数重用、五类原则预检、披露卡与计划文本改写
│   ├── paseo-client.mjs         # Paseo MCP Streamable HTTP 客户端（JSON/SSE 双解析 + 幂等分层重试 + 守护进程自拉起）
│   ├── session-guard.mjs        # STAGED/ACTIVE/CLOSED 状态机、inflight 并发锁与 events.jsonl 单写者
│   └── mcp-server.mjs           # Stdio JSON-RPC 2.0 网关（9 工具白名单）
├── scripts/
│   ├── setup.mjs                # 安装期构建脚本（生成 mcp_config.json、转换技能、写入 source-lock.json）
│   └── smoke.mjs                # 21 项全链路端到端门禁与实机连通性测试
└── docs/
    └── 设计方案-v1.2.md         # 完整架构设计与内阁审议定稿方案
```

---

## 快速安装与使用

### 1. 前置依赖
- 已安装并配置 **[getpaseo/paseo](https://github.com/getpaseo/paseo)**（默认监听 `127.0.0.1:16767`）。
- 本地已克隆 **[pertboem-ops/dsh-cabinet](https://github.com/pertboem-ops/dsh-cabinet)**（默认路径 `~/dsh-cabinet`，或通过环境变量 `CABINET_HOME` 指定）。

### 2. 克隆至 Antigravity 插件目录并构建

```bash
git clone https://github.com/Git-Yi-Zhou/paseo-cabinet.git ~/.gemini/config/plugins/paseo-cabinet
cd ~/.gemini/config/plugins/paseo-cabinet

# 生成本机 mcp_config.json、转换技能文件并生成版本锁 config/source-lock.json
npm run setup

# 运行 21 项门禁与实机连通性自检
npm run smoke
```

### 3. 启用插件
重启一次 Google Antigravity 客户端，在 **Customizations（自定义） → 已安装插件** 中确认 `Paseo Cabinet 内阁议事` 处于开启状态。在对话框中输入：
- `"开个内阁（coding 场景）：审议当前项目的核心架构演进方案"`
- `"开个内阁（writing 场景）：评审这份大纲的立意、节奏与读者体感"`
- `"开个内阁（research 场景，advanced 档）：对这个命题组织两轮正反交叉质询"`

---

## 自定义阁员模型钉扎

编辑 `config/ministers.json` 中的 `allowedModels` 与 `ministers` 字段即可永久调整默认钉扎；也可在每次开阁前的《组阁前默认钉扎披露卡》确认环节直接通过对话临时改派任意席位的 CLI、模型或思考强度。

---

## 开源许可

[MIT License](./LICENSE) © 2026 Git-Yi-Zhou
