import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localSecret } from '../scripts/local-secrets.mjs';

it('separate launcher processes reuse secrets without mixing session and ingestion credentials',()=>{
 const directory=mkdtempSync(join(tmpdir(),'truthtrace-secrets-'));
 const env={...process.env,TRUTHTRACE_DATA_DIR:directory,TRUTHTRACE_SESSION_SECRET:'',TRUTHTRACE_INGESTION_TOKEN:''};
 try {
  const first=localSecret('TRUTHTRACE_SESSION_SECRET',env);
  const second=execFileSync(process.execPath,['--input-type=module','-e',"import {localSecret} from './scripts/local-secrets.mjs'; process.stdout.write(localSecret());"],{env,encoding:'utf8'});
  expect(second).toBe(first);
  expect(localSecret('TRUTHTRACE_INGESTION_TOKEN',env)).not.toBe(first);
  expect(localSecret('TRUTHTRACE_SESSION_SECRET',{...env,TRUTHTRACE_SESSION_SECRET:'x'.repeat(64)})).toBe('x'.repeat(64));
 } finally { rmSync(directory,{recursive:true,force:true}); }
});
