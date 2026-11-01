import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFiles, createSampleFiles } from '../dist/onboarding.js';
import { EVIDENCE } from '../dist/case-data.js';

test('批量导入保留有效材料，同时明确报告超限和不支持的文件',()=>{
  const image={name:'聊天.png',type:'image/png',size:6000};
  const text={name:'补充说明.MD',type:'',size:200};
  const result=validateFiles([image,{name:'过大.pdf',type:'application/pdf',size:15*1024*1024+1},{name:'表格.xlsx',type:'application/vnd.ms-excel',size:1000},text]);
  assert.deepEqual(result.accepted,[image,text]);
  assert.equal(result.rejected.length,2);
  assert.match(result.rejected.join(' '),/15 MB/);
  assert.match(result.rejected.join(' '),/表格.xlsx/);
});

test('导入最多八份材料，15 MB 边界文件仍可接受',()=>{
  const files=Array.from({length:10},(_,i)=>({name:`材料${i}.pdf`,type:'application/pdf',size:15*1024*1024}));
  const result=validateFiles(files);
  assert.equal(result.accepted.length,8);
  assert.deepEqual(result.rejected,['一次最多导入 8 份材料']);
});

test('示例导入原文覆盖初始分析所引用的材料，不提前加入补充回单',async()=>{
  const files=createSampleFiles();
  assert.equal(files.length,4);
  assert.equal(validateFiles(files).rejected.length,0);
  for(const material of EVIDENCE.filter(e=>!e.extra)){
    const file=files.find(f=>f.name.startsWith(material.id+'-'));
    assert.ok(file);
    const text=await file.text();
    assert.match(text,/虚构示例材料/);
    for(const clue of material.claims)assert.ok(text.includes(clue.quote),`${material.id} 缺少分析引用原文`);
  }
  assert.ok(!files.some(f=>f.name.startsWith('E-05')));
});
