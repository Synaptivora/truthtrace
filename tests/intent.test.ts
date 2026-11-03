import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/investigator/connections",()=>({effectiveConnection:()=>({tools:true})}));
import { fallbackIntent,inferIntent } from "@/lib/investigator/intent";
afterEach(()=>vi.restoreAllMocks());
it("keeps simple questions as chat and treats new evidence as a supplement",()=>{
  expect(fallbackIntent("这句话出自哪份材料？").action).toBe("chat");
  expect(fallbackIntent("我还有一张截图").action).toBe("supplement");
  expect(fallbackIntent("梳理退款时间线").mode).toBe("timeline");
});
it("uses validated model intent, without executing model tools",async()=>{
  const invoke=vi.fn(async()=>({text:"",raw:undefined,calls:[{id:"route",name:"route_request",arguments:JSON.stringify({action:"investigate",mode:"deep",reason:"需要对照多方材料"})}]}));
  expect(await inferIntent("帮我看看整件事",true,new AbortController().signal,invoke)).toMatchObject({action:"investigate",mode:"deep",source:"model"});
  expect(invoke).toHaveBeenCalledOnce();
});
it("falls back explicitly when the model returns an unknown action",async()=>{
  const invoke=async()=>({text:"",raw:undefined,calls:[{id:"bad",name:"route_request",arguments:'{"action":"send_message","mode":"deep","reason":""}'}]});
  expect(await inferIntent("核查退款",true,new AbortController().signal,invoke)).toMatchObject({action:"investigate",source:"rules"});
});
