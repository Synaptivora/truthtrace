import type {
  AnalysisResult,
  Evidence,
  EvidenceRef,
  Person,
  TimelineEvent,
} from "../contracts";

type Relationship = AnalysisResult["relationships"][number];
type Commitment = AnalysisResult["commitments"][number];
import { demoAnalysis, demoEvidence } from "../demo-case";
import { validateAnalysis } from "./validate";

/**
 * 本地规则分析（AI_PROVIDER=rule / 未配置模型密钥时的兜底）。
 *
 * 为什么需要它：
 *   `mock` 只登记证据、不读正文，界面上永远是「00 位相关人物」；而真实模型需要
 *   API Key。两者之间空着一档，用户导完聊天看到全 0，会以为是解析坏了。
 *
 * 它做什么（只做能从文本里确定性推出的事）：
 *   - 发言人列表 → 人物（含发言条数、活跃区间、代表原话）
 *   - 明确 @ 提及 → 关系（不把同群发言当作互动）
 *   - 按时间断点切分对话 → 事件
 *   - 「我会/明天/负责…」句式 → 承诺
 *
 * 它不做什么：不做语义判定，因此**不产出矛盾/疑点**——宁可留空，也不编。
 * 结果标 analysisMode="rule"，界面上明确写「规则分析」，不与模型结论混为一谈。
 */

type Line = {
  evidenceId: string;
  evidenceName: string;
  raw: string;
  time: string;
  sender: string;
  text: string;
  at: number;
};

/** `[2026-10-31 22:38:03] 朱昊亮: 内容` */
const LINE_RE = /^\[([^\]]{4,25})\]\s*([^:：]{1,24})[:：]\s?([\s\S]*)$/;
const NOISE = /^(系统|系统消息|微信团队|群助手|文件传输助手|未知|unknown|system|群成员|群友|有人)$/i;
const SELF = /^(我|本人)$/;
/** 单条消息里的期限线索，用来给「承诺」标一个可读的 dueLabel */
const DUE_RE = /(今天|今晚|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|(\d{1,2})月(\d{1,2})[日号]|(\d{1,2})[点:：]\d{0,2}|月底|周末|尽快|稍后)/;
const TASK_RE = /(我(?:来|会|们)?|本人).{0,10}(会|来|负责|安排|处理|提交|发|确认|联系|整理|统计|通知|交|完成)|(负责|安排|提交|截止|务必|记得|需要)|(明天|今天|今晚|下周|本周|月底|之前).{0,12}(交|发|提交|完成|确认|给)/;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toMs(time: string): number {
  const text = time.trim().replace(" ", "T");
  const stamp = Date.parse(text.length <= 10 ? `${text}T00:00:00` : text);
  return Number.isNaN(stamp) ? 0 : stamp;
}

function timeLabel(time: string): string {
  const text = time.trim();
  return text.length > 10 ? text.slice(5, 16) : text.slice(5);
}

function ref(evidenceId: string, raw: string): EvidenceRef {
  return { evidenceId, quote: raw.length > 160 ? raw.slice(0, 160) : raw };
}

/** 从聊天证据正文里抽出「时间 / 发言人 / 内容」，其余证据按整份材料处理。 */
function parseLines(evidence: Evidence[]): Line[] {
  const lines: Line[] = [];
  for (const item of evidence) {
    if (item.kind !== "chat") continue;
    // 证据名形如「Synapse-黑客松 · 2026-10-31~2026-11-02（208 条）」：群名偶尔被当成
    // 发送人（系统消息缺 sender_wxid 时），不能让它变成一个人
    const title = item.name.split(" · ")[0].trim();
    for (const raw of item.content.split("\n")) {
      const matched = LINE_RE.exec(raw);
      if (!matched) continue;
      const sender = clean(matched[2]);
      if (!sender || NOISE.test(sender) || sender === title) continue;
      lines.push({
        evidenceId: item.id,
        evidenceName: item.name,
        raw,
        time: matched[1].trim(),
        sender: SELF.test(sender) ? "本人（我）" : sender,
        text: clean(matched[3]),
        at: toMs(matched[1]),
      });
    }
  }
  return lines.sort((a, b) => a.at - b.at);
}


function buildPeople(lines: Line[]): { people: Person[]; byName: Map<string, Person> } {
  const buckets = new Map<string, Line[]>();
  for (const line of lines) {
    const list = buckets.get(line.sender);
    if (list) list.push(line);
    else buckets.set(line.sender, [line]);
  }
  const ranked = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 16);
  const people: Person[] = ranked.map(([name, items], index) => {
    const first = items[0];
    const last = items[items.length - 1];
    const texts = items.map(item => item.text).filter(Boolean);
    const samples = texts
      .filter(text => text.length >= 6 && !text.startsWith("["))
      .slice(0, 2);
    return {
      id: `rule-person-${index + 1}`,
      name,
      role: "发言人",
      aliases: [],
      summary: `发言 ${items.length} 条（${timeLabel(first.time)} → ${timeLabel(last.time)}）${
        samples.length ? `；代表原话：「${samples[0].slice(0, 60)}」` : ""
      }`,
      evidenceRefs: items.slice(0, 3).map(item => ref(item.evidenceId, item.raw)),
    };
  });
  const byName = new Map(people.map((person, index) => [ranked[index][0], person]));
  return { people, byName };
}

function buildRelationships(lines: Line[], byName: Map<string, Person>): Relationship[] {
  const relations=new Map<string,Relationship>();
  for(const line of lines) {
    const source=byName.get(line.sender);if(!source)continue;
    for(const [name,target] of byName) {
      if(source.id===target.id)continue;
      const at=line.text.indexOf(`@${name}`);if(at<0)continue;
      const next=line.text[at+name.length+1];
      if(next&&!/[\s，。！？,:：;；]/.test(next))continue;
      const key=`${source.id}:${target.id}`;
      const old=relations.get(key);
      if(old){if(old.evidenceRefs.length<3)old.evidenceRefs.push(ref(line.evidenceId,line.raw));}
      else relations.set(key,{id:`rule-rel-${relations.size+1}`,sourcePersonId:source.id,targetPersonId:target.id,label:"明确提及（@）",evidenceRefs:[ref(line.evidenceId,line.raw)]});
    }
  }
  return [...relations.values()];
}

function buildEvents(lines: Line[], byName: Map<string, Person>): TimelineEvent[] {
  if (lines.length === 0) return [];
  const clusters: Line[][] = [];
  let current: Line[] = [];
  const GAP = 45 * 60 * 1000;
  for (const line of lines) {
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const previous = current[current.length - 1];
    if (line.at - previous.at > GAP) {
      clusters.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) clusters.push(current);
  const picked = clusters
    .sort((a, b) => b.length - a.length)
    .slice(0, 10)
    .sort((a, b) => a[0].at - b[0].at);
  return picked.map((cluster, index) => {
    const speakers = [...new Set(cluster.map(item => item.sender))];
    const head = cluster[0];
    const latest = cluster[cluster.length - 1];
    const standout =
      cluster.find(item => item.text.length >= 8)?.text ||
      head.text ||
      "该时间段内的对话";
    return {
      id: `rule-event-${index + 1}`,
      title: `${timeLabel(head.time)} 起的 ${cluster.length} 条对话`,
      description: `参与者：${speakers.slice(0, 4).join("、")}${speakers.length > 4 ? " 等" : ""}。${
        head.time.slice(0, 10) === latest.time.slice(0, 10) ? "" : "跨日。"
      }片段：「${standout.slice(0, 70)}」`,
      occurredAt: head.at ? new Date(head.at).toISOString() : null,
      timeLabel: timeLabel(head.time),
      timePrecision: head.time.length > 10 ? "exact" : "approximate",
      participantIds: speakers
        .filter(name => byName.has(name))
        .slice(0, 6)
        .map(name => byName.get(name)!.id),
      evidenceRefs: [ref(head.evidenceId, head.raw)],
    };
  });
}

function buildCommitments(lines: Line[], byName: Map<string, Person>): Commitment[] {
  const out: Commitment[] = [];
  for (const line of lines) {
    if (out.length >= 8) break;
    const person = byName.get(line.sender);
    if (!person || !line.text || line.text.length < 6) continue;
    if (!TASK_RE.test(line.text)) continue;
    const due = DUE_RE.exec(line.text)?.[1] || "未标明期限";
    out.push({
      id: `rule-commit-${out.length + 1}`,
      personId: person.id,
      commitment: line.text.slice(0, 90),
      dueLabel: due,
      status: "pending",
      evidenceRefs: [ref(line.evidenceId, line.raw)],
    });
  }
  return out;
}

function evidenceGapOf(evidence: Evidence[], people: Person[]): AnalysisResult["evidenceGaps"] {
  const gaps: AnalysisResult["evidenceGaps"] = [];
  const images = evidence.filter(item => item.kind === "image").length;
  if (images > 0) {
    gaps.push({
      id: "rule-gap-image",
      title: `${images} 张图片未做内容识别`,
      reason: "本地规则只读文字，图片中的转账金额、通知原文需要接模型或人工核对。",
      suggestedEvidence: "配置多模态模型后重新分析，或人工点开图片核对关键信息。",
      relatedEventIds: [],
      evidenceRefs: [],
    });
  }
  if (people.length === 0) {
    gaps.push({
      id: "rule-gap-people",
      title: "未从材料中识别出发言人",
      reason: "材料里没有「[时间] 发言人：内容」格式的对话行，可能是不含说话人的纯文本。",
      suggestedEvidence: "改用渠道直读（钉钉/微信）导入原始聊天记录，或确认导出文件保留了发言人字段。",
      relatedEventIds: [],
      evidenceRefs: [],
    });
  }
  return gaps;
}

export function createRuleAnalysis(evidence: Evidence[]): AnalysisResult {
  // 示例案件仍走预置结果，避免「示例」被规则拆成一堆无意义片段
  const isDemoCase =
    evidence.length === demoEvidence.length &&
    demoEvidence.every(demo => evidence.some(item => item.id === demo.id));
  if (isDemoCase) {
    return validateAnalysis(demoAnalysis, evidence, "rule");
  }

  const lines = parseLines(evidence);
  const { people, byName } = buildPeople(lines);
  const relationships = buildRelationships(lines, byName);
  const events = buildEvents(lines, byName);
  const commitments = buildCommitments(lines, byName);

  const chats = evidence.filter(item => item.kind === "chat");
  const chatCount = chats.length;
  // 聊天导入会附带 N 张图片证据：标题该是那段对话，不是「XX 等 21 份材料」
  const title =
    evidence.length === 1
      ? evidence[0].name
      : chatCount === 1
        ? chats[0].name
        : `${evidence[0]?.name ?? "材料"} 等 ${evidence.length} 份材料`;

  return validateAnalysis(
    {
      caseTitle: title,
      summary: lines.length
        ? `本地规则识别：${chatCount} 段对话、${lines.length} 条消息中识别出 ${people.length} 位发言人、${relationships.length} 条明确提及关系、${events.length} 个时间片段。未启用语义模型，以上仅为发言人与时间的确定性统计，需结合原文核对。`
        : `本地规则识别：${evidence.length} 份材料中未找到「[时间] 发言人：内容」格式的对话行，暂无人物可列。`,
      people,
      relationships,
      events,
      contradictions: [],
      commitments,
      evidenceGaps: evidenceGapOf(evidence, people),
    },
    evidence,
    "rule",
  );
}
