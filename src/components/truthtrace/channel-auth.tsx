"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
export function ChannelAuth({onAuthorized}:{onAuthorized:()=>void}) {
  const [jobId,setJobId]=useState<string|null>(null),[url,setUrl]=useState(""),[error,setError]=useState("");
  const [starting,setStarting]=useState(false);
  const [qr,setQr]=useState(""),[progress,setProgress]=useState("");
  useEffect(()=>{let active=true;if(url)void QRCode.toDataURL(url,{width:220,margin:2,errorCorrectionLevel:"M"}).then(value=>{if(active)setQr(value);});return()=>{active=false;};},[url]);
  const done=useRef(onAuthorized);useEffect(()=>{done.current=onAuthorized;});
  useEffect(()=>{if(!jobId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const r=await fetch(`/api/setup?job=${encodeURIComponent(jobId!)}`,{signal:abort.signal,cache:"no-store"});const data=await r.json();if(!r.ok)throw new Error(data.error||"授权进度读取失败");
      const links=(data.lines||[]).flatMap((line:string)=>line.match(/https:\/\/[^\s"'<>）)]+/g)||[]);
      const link=links.find((value:string)=>{try{return new URL(value).hostname==="login.dingtalk.com";}catch{return false;}});if(link)setUrl(link);
      setProgress(link?"请用手机钉钉扫码，按官方页面确认授权。":data.note||"正在准备连接工具和材料服务…");
      if(data.status==="running")timer=setTimeout(poll,1000);else {setJobId(null);if(data.ok)done.current();else setError(data.note||data.error||"授权未完成，可重试");}
    }catch(e){if(!abort.signal.aborted){setError((e as Error).message);setJobId(null);}}}
    void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[jobId]);
  async function connect(){setStarting(true);setError("");setUrl("");try{
    const r=await fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"login-dingtalk"})});const data=await r.json();
    if(!r.ok&&!(r.status===409&&data.jobId))throw new Error(data.error||"连接未能开始");setQr("");setJobId(data.jobId);
  }catch(e){setError((e as Error).message);}finally{setStarting(false);}}
  return <div className="ci-auth"><h3>连接钉钉，选择要分析的会话</h3><p>自动准备读取服务与连接工具。已登录可直接继续；需要授权时用钉钉扫码确认。</p><button disabled={starting||!!jobId} onClick={()=>void connect()}>{starting?"正在准备…":jobId?"连接进行中…":"连接钉钉"}</button>{jobId&&<p role="status">{progress||"正在准备连接…"}</p>}{qr&&<Image src={qr} alt="钉钉官方授权二维码" width={220} height={220} unoptimized/>}{url&&<a href={url} target="_blank" rel="noreferrer">打开钉钉授权页 ↗</a>}{error&&<p role="alert">{error}</p>}<small>扫码只完成官方授权。随后由你选择会话，不会自动导入全部聊天。</small></div>;
}
