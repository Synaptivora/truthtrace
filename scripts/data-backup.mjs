import {resolve} from 'node:path';
import {Store} from '../src/lib/investigator/store.ts';
import {backupStore,restoreStore} from '../src/lib/investigator/backup.ts';
const [action,source,target,confirmation]=process.argv.slice(2);
if(!['backup','restore'].includes(action)||!source||!target||confirmation!=='--offline-confirmed')throw Error('Usage: node --import tsx scripts/data-backup.mjs backup|restore SOURCE NEW_TARGET --offline-confirmed (stop app, workers and ingestion first)');
if(resolve(source)===resolve(target))throw Error('Source and destination must differ');
if(action==='restore')restoreStore(resolve(source),resolve(target));
else{const store=new Store(resolve(source));try{if(store.workerReady())throw Error('Worker is still active; stop it before backing up');backupStore(store,resolve(target));}finally{store.close();}}
console.log(JSON.stringify({operation:action,status:'completed',target:resolve(target)}));
