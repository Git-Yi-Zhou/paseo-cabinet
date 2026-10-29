# Paseo Cabinet 内阁议事行为纪律 (Lead Orchestrator Rules)

本规则仅在用户触发内阁议事（如提及“开内阁”、“开阁”、“内阁审议”、`/cabinet` 或调用 `paseo-cabinet` 工具集）时生效；日常普通对话与单智能体编程任务不受影响。

## 1. 铁律一：禁用内置同源 Subagent，强制走 `paseo-cabinet` 网关
在内阁议事期间，**严禁**使用 Antigravity 内置的 `invoke_subagent` 充当内阁阁员（内置子智能体与宿主同源，违反红队异源铁律）。所有阁员生命周期必须通过 `paseo-cabinet` MCP 网关提供的 9 个工具（`cabinet_start`, `cabinet_audit`, `list_providers`, `list_models`, `create_agent`, `send_agent_prompt`, `get_agent_status`, `list_agents`, `delete_agent`）调度。

## 2. 铁律二：组阁前默认钉扎披露与交互确认（P9 双阶段握手）
1. **阶段一（草案生成与展示）**：首调 `cabinet_start({ topic, scene, tier, goal })`（不传 `confirm: true`），获取 `STAGED` 态会话令牌 `sessionId` 与《组阁前默认钉扎披露卡》。
2. **必须停等确认**：向用户完整展示披露卡（含当场在席阁员表、八阁员完整默认钉扎表、5 模型及可用思考强度 `thinkingOptions` 对照表、三维异质性与红队异源预检结论），并调用 `ask_question` 询问用户：
   - `(Recommended) 确认默认配置，立即开议`
   - `自定义修改阁员配置（请说明要修改的阁员/席位、CLI provider、模型或思考强度）`
   - `取消组阁`
3. **改定与违背原则提醒**：
   - 若用户要求修改配置，调用 `cabinet_start({ sessionId, topic, scene, tier, goal, overrides: [...] })` 重新执行五类组阁原则预检（Type A 红队同源、Type B 三维全重合/单源退化、Type C 高认知席位降配、Type D 同阁员兼任多席、Type E 越界模型或思考档位）。
   - 若命中 **Type E（物理越界/不可用）**，必须明确拒绝并列出合法可选项，不得放行。
   - 若命中 **Type A–D（软警告）**，必须向用户响亮发出《违背组阁原则提醒》并给出合规替代建议；仅在用户明确表示“知晓风险，强制按此组阁”时，携带网关签发的一次性 `overrideCode`（`OVR-XXXX`）调用 `cabinet_start({ sessionId, confirm: true, overrideCode })` 激活会话。
4. **阶段二（正式激活）**：用户确认无误后，调用 `cabinet_start({ sessionId, confirm: true })` 将会话跃迁为 `ACTIVE`，再按返回的编排计划并发调用 `create_agent` 派发 R1。

## 3. 铁律三：R1 立场速览后强制停等用户
收齐 R1 各席立场书并完成送达核对后，必须输出【共识面】（枚举支持席位）与【分歧面】（编号 D1… 标明对立席位）两栏速览，随后调用 `ask_question` **停下等待用户裁决**（进二轮 / 点名追问 / 升档 / 直接合议 / 散会），严禁未获用户指令擅自抢跑 R2 或直接输出最终议定书。

## 4. 铁律四：`events.jsonl` 单写者保护与 `cabinet_audit` 闭环收尾
- `.cabinet/<sessionId>/events.jsonl` 由 `paseo-cabinet` 桥接网关在拦截 `create_agent` / `send_agent_prompt` 时**唯一原子追加写入**，严禁使用 `write_file` 或 `edit_file` 手动创建或修改 `events.jsonl`。
- 议事结束时，先用 `write_file` 写入 `.cabinet/<sessionId>/round-1.jsonl`（及 `round-2.jsonl`）和 `.cabinet/<sessionId>/protocol.json`，随后**必须调用 `cabinet_audit({ cabinetSessionId, workspaceRoot })`** 完成机器对账、自动追加 `.cabinet/index.jsonl` 并清理销毁本场全部 Paseo 阁员进程。
