/** Only the device-verification flow implemented by the channel adapter. */
export function safeAuthUrl(value:unknown):string {
 if(typeof value!=='string'||value.length>2048)return '';
 try{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='login.dingtalk.com'||url.port||url.username||url.password||url.hash||url.pathname!=='/oauth2/device/verify.htm')return '';
 const keys=[...url.searchParams.keys()];if(keys.length!==1||keys[0]!=='user_code')return '';
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('user_code')||''))return '';
 return url.href;}catch{return '';}
}
export function authUrlFromLines(lines:string[]):string {
 for(const line of lines)for(const candidate of line.match(/https:\/\/[^\s"'<>）)]+/g)||[]){const safe=safeAuthUrl(candidate);if(safe)return safe;}
 return '';
}
