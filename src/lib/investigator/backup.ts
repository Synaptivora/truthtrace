import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,existsSync,lstatSync} from "node:fs";
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
 const manifest=JSON.parse(readFileSync(join(source,"manifest.json"),"utf8"));
 if(manifest.schemaVersion!==2||!Array.isArray(manifest.files))throw Error("Unsupported backup");
 for(const entry of manifest.files){const path=resolve(source,entry.path),rel=relative(resolve(source),path);if(!rel||rel.startsWith("..")||isAbsolute(rel)||lstatSync(path).isSymbolicLink()||hash(path)!==entry.hash)throw Error("Backup integrity failure");}
 mkdirSync(target,{recursive:true});for(const entry of manifest.files){const output=join(target,entry.path);mkdirSync(resolve(output,".."),{recursive:true});copyFileSync(join(source,entry.path),output);}
 const store=new Store(target);try{const result=store.db.prepare("PRAGMA integrity_check").get() as {integrity_check:string};if(result.integrity_check!=="ok")throw Error("Database integrity failure");}finally{store.close();}
}
