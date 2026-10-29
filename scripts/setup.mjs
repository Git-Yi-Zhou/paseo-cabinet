#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const CABINET_HOME = resolve(process.env.CABINET_HOME || join(homedir(), "dsh-cabinet"));

function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}

function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function adaptSkillMarkdown(rawMd) {
  let out = String(rawMd);
  out = out.replace(/# Cabinet 内阁议事（dsh 版）/g, "# Cabinet 内阁议事（Paseo + Antigravity 版）");
  out = out.replace(/list_subagent_models/g, "list_providers / list_models");
  out = out.replace(/ask_user_question/g, "ask_question");
  out = out.replace(/\bsend_message\b/g, "send_agent_prompt");

  const p9Section = [
    ``,
    `## Paseo 网关双阶段组阁确认规程（P9 强制门禁）`,
    ``,
    `- **阶段 1（草案与披露卡）**：首调 \`cabinet_start({ topic, scene, tier, goal })\`（**不传** \`confirm: true\`），网关返回 \`STAGED\` 状态的 \`sessionId\` 与《组阁前默认钉扎披露卡》（含在场席位表、八阁员默认钉扎表、5 模型与思考档位白名单）。`,
    `- **停等用户确认**：向用户完整展示披露卡并调用 \`ask_question\`（确认当前配置 / 修改阁员配置 / 取消组阁）。未获确认前，会话处于 \`STAGED\`，调用 \`create_agent\` 会被网关硬拦截（\`CABINET_SESSION_NOT_ACTIVE\`）。`,
    `- **改定与违背原则提醒**：若用户修改某席位的 CLI（\`provider\`）、模型（\`model\`）或思考强度（\`thinkingOptionId\`），调用 \`cabinet_start({ sessionId, topic, scene, tier, overrides: [...] })\` 重跑 Type A–E 组阁原则预检。若触发软警告（Type A–D），必须向用户发出违背原则提醒；仅在用户明确要求强制放行时传入一次性 \`overrideCode\`（\`OVR-XXXX\`）。Type E（越界/不支持的档位）严禁放行。`,
    `- **阶段 2（正式激活）**：用户确认后，调用 \`cabinet_start({ sessionId, confirm: true })\` 将会话激活为 \`ACTIVE\`，获取完整编排计划并传入 \`cabinetSessionId\` 调 \`create_agent\` 派发 R1。`,
    `- **单写者归档与闭环审计**：\`events.jsonl\` 由网关唯一自动追加写入，**严禁手动用 \`write_file\` 覆写**；归档 \`round-1.jsonl\` 与 \`protocol.json\` 后，必须调用 \`cabinet_audit({ cabinetSessionId, workspaceRoot })\` 对账、回填 \`index.jsonl\` 并自动销毁本场 Paseo 阁员进程。`,
    ``,
  ].join("\n");

  if (out.includes("## 开阁方式（双通道）")) {
    out = out.replace("## 开阁方式（双通道）", `${p9Section}## 开阁方式（双通道）`);
  }
  return out;
}

console.log(`[setup] PLUGIN_ROOT  = ${PLUGIN_ROOT}`);
console.log(`[setup] CABINET_HOME = ${CABINET_HOME}`);

// 1. 生成 mcp_config.json
const tplPath = join(PLUGIN_ROOT, "mcp_config.template.json");
const mcpOutPath = join(PLUGIN_ROOT, "mcp_config.json");
const tplContent = readFileSync(tplPath, "utf8");
const renderedMcp = tplContent
  .replaceAll("__NODE_EXE__", toPosixPath(process.execPath))
  .replaceAll("__PLUGIN_ROOT__", toPosixPath(PLUGIN_ROOT))
  .replaceAll("__CABINET_HOME__", toPosixPath(CABINET_HOME));
writeFileSync(mcpOutPath, renderedMcp, "utf8");
console.log(`[setup] 已生成 mcp_config.json`);

// 2. 转换并生成 4 个技能文件 skills/*/SKILL.md
const skillMappings = [
  {
    src: join(CABINET_HOME, "skills", "cabinet.md"),
    dest: join(PLUGIN_ROOT, "skills", "cabinet", "SKILL.md"),
  },
  {
    src: join(CABINET_HOME, "skills", "roles", "coding.md"),
    dest: join(PLUGIN_ROOT, "skills", "cabinet-roles-coding", "SKILL.md"),
  },
  {
    src: join(CABINET_HOME, "skills", "roles", "writing.md"),
    dest: join(PLUGIN_ROOT, "skills", "cabinet-roles-writing", "SKILL.md"),
  },
  {
    src: join(CABINET_HOME, "skills", "roles", "research.md"),
    dest: join(PLUGIN_ROOT, "skills", "cabinet-roles-research", "SKILL.md"),
  },
];

const fileHashes = {
  "lib/index.js": sha256File(join(CABINET_HOME, "lib", "index.js")),
  "scripts/audit.mjs": sha256File(join(CABINET_HOME, "scripts", "audit.mjs")),
};

for (const item of skillMappings) {
  if (!existsSync(item.src)) {
    throw new Error(`[setup] 源技能文件缺失: ${item.src}`);
  }
  mkdirSync(dirname(item.dest), { recursive: true });
  const raw = readFileSync(item.src, "utf8");
  const adapted = adaptSkillMarkdown(raw);
  writeFileSync(item.dest, adapted, "utf8");

  if (! existsSync(item.dest) || statSync(item.dest).size < 100 || !adapted.startsWith("---")) {
    throw new Error(`[setup] 技能文件生成校验失败: ${item.dest}`);
  }
  const relKey = toPosixPath(item.src.slice(CABINET_HOME.length + 1));
  fileHashes[relKey] = sha256File(item.src);
  console.log(`[setup] 已生成技能: ${toPosixPath(item.dest)}`);
}

// 3. 生成 config/source-lock.json
const dshPkg = JSON.parse(readFileSync(join(CABINET_HOME, "package.json"), "utf8"));
let gitCommit = "unknown";
try {
  gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: CABINET_HOME,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
} catch {
  // ignore if git unavailable
}

const sourceLock = {
  dshCabinetPath: toPosixPath(CABINET_HOME),
  dshCabinetVersion: dshPkg.version,
  dshCabinetCommit: gitCommit,
  generatedAt: new Date().toISOString(),
  hashes: fileHashes,
};
const lockPath = join(PLUGIN_ROOT, "config", "source-lock.json");
writeFileSync(lockPath, JSON.stringify(sourceLock, null, 2) + "\n", "utf8");
console.log(`[setup] 已写入版本锁: ${toPosixPath(lockPath)} (dsh-cabinet@${dshPkg.version} #${gitCommit.slice(0, 8)})`);
