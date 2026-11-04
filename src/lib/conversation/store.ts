import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import type {AgentReply} from "../agent/contracts";
import {EvidenceRefSchema,CoverageSchema} from "../contracts";
const citation=z.object({id:z.string(),evidenceId:z.string(),name:z.string(),excerpt:z.string(),refs:z.array(EvidenceRefSchema).optional()});
const replySchema=z.object({text:z.string(),mode:z.enum(["model","demo"]),model:z.string().optional(),citations:z.array(citation),steps:z.array(z.string()),coverage:CoverageSchema.optional(),sourceSupport:z.literal("unchecked").optional(),factualVerification:z.literal("not_checked").optional(),citationStatus:z.enum(["source_identity_only","unverified_answer"]).optional()});
export type ConversationTurn={role:"user"|"assistant";content:string;reply?:AgentReply};
export type Conversation={id:string;caseId:string;revision:number;turns:ConversationTurn[];summary:{text:string;sourceRevision:number;sourceTurnIndexes:number[];refs:unknown[]}|null};
export class Conversations {
 constructor(private db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,body TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS conversations_case_delete AFTER DELETE ON cases BEGIN DELETE FROM conversations WHERE case_id=OLD.id; END;");}
 private caseExists(caseId:string){if(!this.db.prepare("SELECT id FROM cases WHERE id=?").get(caseId))throw Error("案件不存在");}
 get(caseId:string,id:string):Conversation {this.caseExists(caseId);const row=this.db.prepare("SELECT body FROM conversations WHERE id=? AND case_id=?").get(id,caseId);if(!row)throw Error("会话不存在或不属于本案");return JSON.parse(String(row.body));}
 list(caseId:string){this.caseExists(caseId);return this.db.prepare("SELECT id,revision,updated FROM conversations WHERE case_id=? ORDER BY updated DESC,id LIMIT 100").all(caseId);}
 latest(caseId:string):Conversation|null{this.caseExists(caseId);const row=this.db.prepare("SELECT body FROM conversations WHERE case_id=? ORDER BY updated DESC,id LIMIT 1").get(caseId);return row?JSON.parse(String(row.body)):null;}
 create(caseId:string){this.caseExists(caseId);const c:Conversation={id:randomUUID(),caseId,revision:1,turns:[],summary:null};this.db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?)").run(c.id,caseId,1,Date.now(),JSON.stringify(c));return c;}
 private write(c:Conversation,expected:number){const body=JSON.stringify({...c,revision:expected+1});if(Buffer.byteLength(body)>1024*1024||c.turns.length>300)throw Error("会话容量已满，请新建会话");const result=this.db.prepare("UPDATE conversations SET body=?,revision=?,updated=? WHERE id=? AND case_id=? AND revision=?").run(body,expected+1,Date.now(),c.id,c.caseId,expected);if(result.changes!==1)throw Error("会话已修改，请刷新后重试");return JSON.parse(body) as Conversation;}
 append(caseId:string,id:string,expected:number,question:string,reply:AgentReply,summary:Conversation["summary"]){const c=this.get(caseId,id);if(c.revision!==expected)throw Error("会话已修改，请刷新后重试");const clean=replySchema.parse(reply);c.turns.push({role:"user",content:z.string().min(1).max(12000).parse(question)},{role:"assistant",content:clean.text,reply:clean});c.summary=summary;return this.write(c,expected);}
 edit(caseId:string,id:string,expected:number,index:number,content?:string){const c=this.get(caseId,id);if(c.revision!==expected||!Number.isInteger(index)||index<0||index>=c.turns.length)throw Error("会话版本或消息无效");c.turns=c.turns.slice(0,content===undefined?index:index+1);if(content!==undefined)c.turns[index]={...c.turns[index],role:"user",content:z.string().trim().min(1).max(12000).parse(content),reply:undefined};c.summary=null;return this.write(c,expected);}
 clearSummary(caseId:string,id:string,expected:number){const c=this.get(caseId,id);if(c.revision!==expected)throw Error("会话已修改");c.summary=null;return this.write(c,expected);}
 remove(caseId:string,id:string,expected:number){this.get(caseId,id);if(this.db.prepare("DELETE FROM conversations WHERE id=? AND case_id=? AND revision=?").run(id,caseId,expected).changes!==1)throw Error("会话已修改");}
}
