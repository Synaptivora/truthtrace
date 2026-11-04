import { NextResponse, type NextRequest } from 'next/server';
import { session, trusted } from './lib/security/boundary';
export function proxy(request: NextRequest) {
  if (!trusted(request)) return new NextResponse('Forbidden',{status:403});
  const response=NextResponse.next();
  if(process.env.TRUTHTRACE_LOCAL_BOOTSTRAP==='1' && request.method==='GET' && request.headers.get('sec-fetch-mode')==='navigate' && request.headers.get('sec-fetch-dest')==='document' && ['none','same-origin'].includes(request.headers.get('sec-fetch-site') || '')) {
    response.cookies.set('tt_session',session(),{httpOnly:true,sameSite:'strict',path:'/',maxAge:43200});
  }
  return response;
}
export const config={matcher:['/','/api/:path*']};
