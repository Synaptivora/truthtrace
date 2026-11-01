import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const root = join(import.meta.dirname, 'dist');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'};
http.createServer(async (req,res)=>{
  const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'') || 'index.html';
  if (name.includes('..') || !types[extname(name)]){res.writeHead(404);res.end();return}
  try{const file=await readFile(join(root,name));res.writeHead(200,{'content-type':types[extname(name)]});res.end(file)}catch{res.writeHead(404);res.end()}
}).listen(4173,'127.0.0.1',()=>console.log('http://127.0.0.1:4173'));
