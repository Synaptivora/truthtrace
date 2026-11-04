import {z} from "zod";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,existsSync,lstatSync,realpathSync} from "node:fs";
import {join,resolve,relative,isAbsolute} from "node:path";
import {Store} from "./store";
function hash(path:string){return createHash("sha256").update(readFileSync(path)).digest("hex");}
/** Call while ingestion/archive deletion is stopped. Never overwrite a backup. */
export function backupStore(store:Store,target:string){
 if(existsSync(target))throw Error("Backup destination must not exist");mkdirSync(target,{recursive:true});
 store.db.prepare("VACUUM INTO ?").run(join(resolve(target),"cases.sqlite"));
 const files:{path:string;hash:string}[]=[];
 for(const directory of ["objects","originals"]){const source=join(store.directory,directory);if(!existsSync(source))continue;mkdirSync(join(target,directory));for(const name of readdirSync(source)){const file=join(source,name);if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw Error("Invalid backup entry");copyFileSync(file,join(target,directory,name));files.push({path:directory+"/"+name,hash:hash(file)});}}
 for(const name of readdirSync(store.directory).filter(n=>n.endsWith(".enc")||n==="master.dpapi")){const source=join(store.directory,name);if(lstatSync(source).isSymbolicLink())throw Error("Invalid key entry");copyFileSync(source,join(target,name));files.push({path:name,hash:hash(source)});}
 files.push({path:"cases.sqlite",hash:hash(join(target,"cases.sqlite"))});
 const manifest={schemaVersion:2,createdAt:new Date().toISOString(),keyRecovery:"Windows DPAPI keys require the original OS user; otherwise reconnect models",files};
 writeFileSync(join(target,"manifest.json"),JSON.stringify(manifest,null,2));return manifest;
}
export function restoreStore(source:string,target:string){
 if(existsSync(target))throw Error("Restore destination must not exist");
 const manifest=z.object({schemaVersion:z.literal(2),createdAt:z.string(),keyRecovery:z.string(),files:z.array(z.object({path:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1)}).strict().parse(JSON.parse(readFileSync(join(source,"manifest.json"),"utf8")));
 const root=realpathSync(source);const names=new Set<string>();
 for(const entry of manifest.files){
   if(names.has(entry.path)||!(/^(cases\.sqlite|master\.dpapi|connection(?:-[a-z]+)?\.enc|(?:objects|originals)\/[a-f0-9]{64})$/.test(entry.path)))throw Error("Invalid manifest path");names.add(entry.path);
   const path=join(root,entry.path);const real=realpathSync(path),rel=relative(root,real);
   if(!rel||rel.startsWith("..")||isAbsolute(rel)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||hash(path)!==entry.hash)throw Error("Backup integrity failure");
 }
 if(!names.has("cases.sqlite"))throw Error("Missing backup database");
 const db=new DatabaseSync(join(root,"cases.sqlite"),{readOnly:true});
 try{
   if((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version!==2||(db.prepare("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check!=="ok")throw Error("Invalid database version or integrity");
   for(const row of db.prepare("SELECT hash,body FROM evidence").all() as {hash:string;body:string}[]){const evidence=JSON.parse(row.body);if(createHash("sha256").update(evidence.kind+"\0"+evidence.content).digest("hex")!==row.hash||!names.has("objects/"+row.hash)||readFileSync(join(root,"objects",row.hash),"utf8")!==evidence.content)throw Error("Missing or inconsistent evidence object");if(evidence.originalHash&&(!names.has("originals/"+evidence.originalHash)||hash(join(root,"originals",evidence.originalHash))!==evidence.originalHash))throw Error("Missing original");}
   for(const row of db.prepare("SELECT body FROM tasks").all() as {body:string}[]){const task=JSON.parse(row.body);if(task.snapshotId){const snap=db.prepare("SELECT body FROM task_snapshots WHERE id=?").get(task.snapshotId) as {body:string}|undefined;if(!snap||createHash("sha256").update(snap.body).digest("hex")!==task.snapshotId)throw Error("Missing or invalid task snapshot");}}
 }finally{db.close();}
 mkdirSync(target,{recursive:true});for(const entry of manifest.files){const output=join(target,entry.path);mkdirSync(resolve(output,".."),{recursive:true});copyFileSync(join(source,entry.path),output);}
 const store=new Store(target);try{const result=store.db.prepare("PRAGMA integrity_check").get() as {integrity_check:string};if(result.integrity_check!=="ok")throw Error("Database integrity failure");}finally{store.close();}
}
