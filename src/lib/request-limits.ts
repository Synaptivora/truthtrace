export const MATERIAL_REQUEST_BYTES = 25 * 1024 * 1024;
export const CONTROL_REQUEST_BYTES = 2 * 1024 * 1024;
export function requestBodyLimit(pathname: string, contentType = ''): number {
  return pathname === '/api/analyze' || pathname === '/api/cases' || pathname.startsWith('/api/cases/') || contentType.includes('multipart/form-data')
    ? MATERIAL_REQUEST_BYTES : CONTROL_REQUEST_BYTES;
}
export function materialRequestBody(value: unknown): string {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body).byteLength;
  if(bytes > MATERIAL_REQUEST_BYTES)throw new Error(`本次材料约 ${(bytes/1024/1024).toFixed(1)} MiB，超过单次 25 MiB。请缩短时间范围，或减少图片、附件后分批导入；已有材料不会删除。`);
  return body;
}
