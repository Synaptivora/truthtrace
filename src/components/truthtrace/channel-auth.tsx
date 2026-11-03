"use client";
import { useEffect, useRef, useState } from "react";
export function ChannelAuth({onAuthorized}:{onAuthorized:()=>void}) {
  const [jobId,setJobId]=useState<string|null>(null),[url,setUrl]=useState(""),[error,setError]=useState("");
  const [starting,setStarting]=useState(false);
  const done=useRef(onAuthorized);useEffect(()=>{done.current=onAuthorized;});
  useEffect(()=>{if(!jobId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const r=await fetch(`/api/setup?job=${encodeURIComponent(jobId!)}`,{signal:abort.signal,cache:"no-store"});const data=await r.json();if(!r.ok)throw new Error(data.error||"授权进度读取失败");
      const links=(data.lines||[]).flatMap((line:string)=>line.match(/https:\/\/[^\s"'<>）)]+/g)||[]);
      const link=links.find((value:string)=>{try{return new URL(value).hostname==="login.dingtalk.com";}catch{return false;}});if(link)setUrl(link);
      if(data.status==="running")timer=setTimeout(poll,1000);else {setJobId(null);if(data.ok)done.current();else setError(data.note||data.error||"授权未完成，可重试");}
    }catch(e){if(!abort.signal.aborted){setError((e as Error).message);setJobId(null);}}}
    void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[jobId]);
  async function connect(){setStarting(true);setError("");setUrl("");try{
    const r=await fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"login-dingtalk"})});const data=await r.json();
    if(!r.ok)throw new Error(data.error||"连接未能开始");setJobId(data.jobId);
  }catch(e){setError((e as Error).message);}finally{setStarting(false);}}
  return <div className="ci-auth"><h3>先连接你的钉钉</h3><p>完成本人授权后，会自动显示会话选择。选定后才导入案件，不会自动把全部聊天交给模型。</p><button disabled={starting||!!jobId} onClick={()=>void connect()}>{starting?"正在准备授权…":jobId?"等待你确认授权…":"连接钉钉"}</button>{url&&<a href={url} target="_blank" rel="noreferrer">打开钉钉授权页 ↗</a>}{error&&<p role="alert">{error}</p>}</div>;
}
