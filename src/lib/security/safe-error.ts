const messages:Record<string,string>={MODEL_AUTH:'API Key 无效或与地域不匹配',MODEL_BALANCE:'账户余额不足，请在模型供应商控制台充值',MODEL_FORBIDDEN:'账号无权调用该模型',MODEL_NOT_FOUND:'模型名称、协议或 API 地址不正确',MODEL_RATE:'请求过于频繁或额度受限，请稍后重试',MODEL_PROTOCOL:'请求不兼容：请检查协议、模型及工具调用支持',UPLOAD_EMPTY:'请至少上传一个文件',UPLOAD_COUNT:'单次最多上传 20 个文件'};
const statuses:Record<string,string>={'401':'MODEL_AUTH','402':'MODEL_BALANCE','403':'MODEL_FORBIDDEN','404':'MODEL_NOT_FOUND','429':'MODEL_RATE','400':'MODEL_PROTOCOL'};
export function safeError(value:unknown):{code:string;error:string} {
 const text=value instanceof Error?value.message:typeof value==='string'?value:'';
 const status=/^模型服务 HTTP (\d{3})：/.exec(text)?.[1];
 const code=status&&statuses[status]||Object.keys(messages).find(code=>messages[code]===text)||'REQUEST_FAILED';
 return {code,error:messages[code]||'请求处理失败，请检查设置或稍后重试'};
}
