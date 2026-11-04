import { expect,test } from 'vitest';
import { safeAuthUrl,authUrlFromLines } from '../src/lib/security/auth-url';
import { safeError } from '../src/lib/security/safe-error';
test('extracts only official device URL without exposing raw log',()=>{
 const url='https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-12';
 expect(authUrlFromLines(['private filesystem path secret',`Open ${url}`])).toBe(url);
 for(const invalid of [url.replace('https:','http:'),url.replace('login.dingtalk.com','login.dingtalk.com.evil.test'),url+'&access_token=secret',url.replace('/oauth2/device/verify.htm','/redirect'),url.replace('https://','https://user:pass@')])expect(safeAuthUrl(invalid)).toBe('');
});
test('safe model balance feedback preserves user action without upstream text',()=>{
 const result=safeError(new Error('模型服务 HTTP 402：private secret'));
 expect(result.code).toBe('MODEL_BALANCE');expect(result.error).toContain('充值');expect(result.error).not.toContain('private');
 expect(safeError('private credentials').code).toBe('REQUEST_FAILED');
});
