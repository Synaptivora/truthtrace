import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ConnectionSchema, resolveConnection, type Connection } from "../agent/providers";
import { dataDir } from "./store";

// Windows local deployment: the AES master key is protected for the current OS user by DPAPI.
// No shell interpolation of credentials; only a base64 payload is passed on stdin.
function protect(bytes:Buffer, decrypt=false) {
  if(process.platform!=="win32")throw new Error("持久密钥目前支持 Windows DPAPI；其他系统请使用环境变量连接");
  const operation=decrypt?"Unprotect":"Protect";
  const script=`Add-Type -AssemblyName System.Security; $payload=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${operation}($payload,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return Buffer.from(execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{input:bytes.toString("base64"),encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]}).trim(),"base64");
}
function master(create=false) {
  mkdirSync(dataDir(),{recursive:true});const path=join(dataDir(),"master.dpapi");
  if(!existsSync(path)) {
    if(!create)throw new Error("本地连接密钥不存在");
    try{writeFileSync(path,protect(randomBytes(32)),{flag:"wx"});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  }
  return protect(readFileSync(path),true);
}
export type ConnectionRole="shared"|"chat"|"analysis"|"investigation";
function connectionPath(role:ConnectionRole) {if(!["shared","chat","analysis","investigation"].includes(role))throw new Error("无效连接用途");return join(dataDir(),role==="shared"?"connection.enc":`connection-${role}.enc`);}
export function savedConnection(role:ConnectionRole="shared"): Connection | undefined {
  const path=connectionPath(role);if(!existsSync(path))return;
  const packed=readFileSync(path);const cipher=createDecipheriv("aes-256-gcm",master(),packed.subarray(0,12));cipher.setAuthTag(packed.subarray(12,28));
  return ConnectionSchema.parse(JSON.parse(Buffer.concat([cipher.update(packed.subarray(28)),cipher.final()]).toString()));
}
export function saveConnection(input:unknown,role:ConnectionRole="shared") {
  const config=resolveConnection(ConnectionSchema.parse(input))!;
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",master(true),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(config)),cipher.final()]);
  writeFileSync(connectionPath(role),Buffer.concat([iv,cipher.getAuthTag(),encrypted]));
}
export function effectiveConnection(input?:Connection,role:ConnectionRole="chat") {return resolveConnection(input??savedConnection(role)??savedConnection());}
