import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {mockGoogleKeys,googleToken} from './helpers/google.mjs';
import {createApp} from '../server/app.mjs';

test('Google login and checkout use providers; signed callbacks and webhooks credit once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ss-live-'));const app=createApp({NODE_ENV:'test',DEMO_MODE:'false',DB_PATH:join(dir,'db'),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',PAYMENTS_ENABLED:'true',RAZORPAY_KEY_ID:'rzp_test_key',RAZORPAY_KEY_SECRET:'payment-secret',RAZORPAY_WEBHOOK_SECRET:'webhook-secret'});
 const server=app.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port,original=globalThis.fetch;let cookie='',providerOrder=0;
 const restoreGoogle=mockGoogleKeys();
 const payment={id:'pay_confirmed',order_id:'order_1',status:'captured',captured:true,amount:12500,currency:'INR'};
 globalThis.fetch=async(url,options)=>{
  if(url.startsWith(origin))return original(url,options);
  if(url.endsWith('/orders')){const body=JSON.parse(options.body);assert.equal(body.amount,12500);return Response.json({...body,id:'order_'+(++providerOrder)});}
  if(url.endsWith('/payments/pay_confirmed'))return Response.json(payment);
  throw new Error('Unexpected provider request '+url);
 };
 const req=async(path,body,extra={})=>{const r=await fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-SkillSwap-Request':'1',Cookie:cookie,...extra},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=(r.headers.getSetCookie().find(x=>x.startsWith('ss_session='))||r.headers.getSetCookie()[0]).split(';')[0];const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};};
 try{
 assert.equal((await req('/config')).data.demo,false);assert.equal((await req('/demo/enter',{role:'student'})).status,404);
 const c=await req('/auth/google/challenge',{});
 assert.equal((await req('/auth/google',{credential:googleToken(c.data.nonce)})).status,200);
 await req('/profile',{role:'student',name:'Live learner',age:20,domain:'Coding lessons'});
 const order=await req('/orders',{kind:'silver',credits:90,price:1});assert.equal(order.data.gateway.amount,12500);assert.equal(order.data.qr,undefined);
 const id=order.data.order.id;assert.equal((await req('/orders/'+id+'/submit',{utr:'123456789012'})).status,410);
 const verify={razorpay_order_id:'order_1',razorpay_payment_id:'pay_confirmed',razorpay_signature:createHmac('sha256','payment-secret').update('order_1|pay_confirmed').digest('hex')};
 assert.equal((await req('/orders/'+id+'/verify',{...verify,razorpay_signature:'0'.repeat(64)})).status,400);
 assert.equal((await req('/orders/'+id+'/verify',verify)).status,200);assert.equal((await req('/wallet')).data.balance.silver,150);
 const event={event:'payment.captured',payload:{payment:{entity:payment}}},sig=createHmac('sha256','webhook-secret').update(JSON.stringify(event)).digest('hex');
 assert.equal((await req('/payments/webhook',event,{'X-Razorpay-Signature':'bad'})).status,401);assert.equal((await req('/payments/webhook',event,{'X-Razorpay-Signature':sig})).status,200);assert.equal((await req('/wallet')).data.balance.silver,150);
 assert.equal((await req('/teacher/earnings')).status,403);
 }finally{restoreGoogle();globalThis.fetch=original;await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});}
});
test('demo databases cannot be switched into live funds',()=>{const dir=mkdtempSync(join(tmpdir(),'ss-mode-')),path=join(dir,'db');try{const a=createApp({NODE_ENV:'test',DEMO_MODE:'true',DB_PATH:path});a.close();assert.throws(()=>createApp({NODE_ENV:'test',DEMO_MODE:'false',DB_PATH:path}),/separate empty database/);}finally{rmSync(dir,{recursive:true,force:true});}});
