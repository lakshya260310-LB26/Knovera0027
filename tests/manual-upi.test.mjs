import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {mockGoogleKeys,googleToken} from './helpers/google.mjs';

test('UPI QR uses listed amount; claims require bank-verified admin approval and cannot credit twice',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knovera-upi-')),restore=mockGoogleKeys();
 const a=createApp({NODE_ENV:'test',DB_PATH:join(dir,'db'),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',ADMIN_EMAIL:'owner@gmail.com',MANUAL_UPI_ENABLED:'true',UPI_ID:'9680877599@ybl'});
 const server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 const req=async(path,body,cookie='')=>{const r=await fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-SkillSwap-Request':'1',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().find(x=>x.startsWith('ss_session='))?.split(';')[0]||r.headers.getSetCookie()[0]?.split(';')[0]};};
 const login=async(overrides={})=>{const c=await req('/auth/google/challenge',{});return req('/auth/google',{credential:googleToken(c.data.nonce,overrides)},c.cookie);};
 try{
  assert.equal((await req('/config')).data.manualPayments,true);
  const student=(await login()).cookie;
  await req('/profile',{role:'student',name:'UPI learner',age:20,domain:'Coding lessons'},student);
  const order=await req('/orders',{kind:'silver',credits:90,price:1},student);
  assert.equal(order.status,201);assert.equal(order.data.manual,true);assert.match(order.data.qr,/^data:image\/png;base64,/);
  const params=new URL(order.data.uri).searchParams;assert.equal(params.get('pa'),'9680877599@ybl');assert.equal(params.get('am'),'125.00');assert.equal(params.get('cu'),'INR');
  const id=order.data.order.id;
  assert.equal((await req('/orders/'+id+'/submit',{utr:'123456789012'},student)).status,200);
  assert.equal((await req('/wallet',null,student)).data.balance.silver,60);
  const approval={decision:'approve',bankVerified:true,reference:'123456789012',note:'Checked exact received amount against bank records'};
  assert.equal((await req('/admin/orders/'+id,approval,student)).status,403);
  const admin=(await login({sub:'owner',email:'owner@gmail.com'})).cookie;
  assert.equal((await req('/admin/orders/'+id,{...approval,bankVerified:false},admin)).status,400);
  assert.equal((await req('/admin/orders/'+id,{...approval,reference:'000000000000'},admin)).status,400);
  assert.equal((await req('/admin/orders/'+id,approval,admin)).status,200);
  assert.equal((await req('/admin/orders/'+id,approval,admin)).status,200);
  assert.equal((await req('/wallet',null,student)).data.balance.silver,150);
  const other=await req('/orders',{kind:'gold',credits:30},student);
  assert.equal(new URL(other.data.uri).searchParams.get('am'),'150.00');
  assert.equal((await req('/orders/'+other.data.order.id+'/submit',{utr:'123456789012'},student)).status,409);
 }finally{restore();await new Promise(r=>server.close(r));a.close();rmSync(dir,{recursive:true,force:true});}
});
