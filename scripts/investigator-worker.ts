import nextEnv from "@next/env";
import { Store } from "../src/lib/investigator/store";
import { workOnce } from "../src/lib/investigator/runtime";
nextEnv.loadEnvConfig(process.cwd());
const store=new Store();
let stop=false;
process.on("SIGINT",()=>{stop=true;});
process.on("SIGTERM",()=>{stop=true;});
console.log("TruthTrace investigator worker started; Ctrl+C stops after the current task.");
try {while(!stop){if(!await workOnce(store))await new Promise(r=>setTimeout(r,1000));}}
finally {store.close();}
