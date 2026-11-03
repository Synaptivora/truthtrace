// GitHub Pages hosts project information only. Never move API source or destroy the local build.
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const output=fileURLToPath(new URL('../out/',import.meta.url));
mkdirSync(output,{recursive:true});
writeFileSync(output+'/index.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TruthTrace · 启动工作台</title><style>body{max-width:760px;margin:8vh auto;padding:24px;font:18px/1.8 system-ui;background:#f7edda;color:#503820}h1{font-size:42px}pre{padding:20px;background:#fff9ed;border:1px solid #b78d53;overflow:auto}a{color:#854a23}small{display:block;margin-top:32px}</style><h1>TruthTrace</h1><p>把聊天记录整理为有原文依据的人物互动、时间线与调查结果。</p><h2>完整工作台在本机运行</h2><p>此页为项目说明。GitHub Pages 不运行模型 API、案件数据库、Python 解析服务或钉钉授权。请下载项目，在本机启动：</p><pre>npm install
npm run build
npm run start:local</pre><p>然后打开 <a href="http://127.0.0.1:3000">本地工作台</a>。在助手设置中连接模型；导入钉钉时点击连接，按官方页面扫码授权。</p><p><a href="https://github.com/Synaptivora/truthtrace">查看源码与使用说明</a></p><small>密钥保存在本机；此展示页不接收聊天记录或 API Key。</small></html>`,'utf8');
console.log('Project page generated in out; API source and .next left intact.');
