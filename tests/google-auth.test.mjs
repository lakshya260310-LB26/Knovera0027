import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.mjs';
import {mockGoogleKeys,googleToken} from './helpers/google.mjs';

test('Google login validates signed identity, browser nonce, replay and account ownership; SMS is disabled',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ss-google-')),restore=mockGoogleKeys();
 const a=createApp({NODE_ENV:'test',DB_PATH:join(dir,'db'),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',ADMIN_EMAIL:'owner@gmail.com',TWILIO_ACCOUNT_SID:'old',TWILIO_AUTH_TOKEN:'old',TWILIO_VERIFY_SERVICE_SID:'old'});
 const server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 const req=async(path,body,cookie='',extra={})=>{const r=await fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-SkillSwap-Request':'1',Cookie:cookie,...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().find(x=>x.startsWith('ss_session='))?.split(';')[0]||r.headers.getSetCookie()[0]?.split(';')[0]};};
 const challenge=()=>req('/auth/google/challenge',{});
 const login=async(overrides={})=>{const c=await challenge();return req('/auth/google',{credential:googleToken(c.data.nonce,overrides)},c.cookie);};
 try{
  assert.equal((await req('/auth/send',{phone:'+919876543210'})).status,410);
  assert.equal((await req('/auth/verify',{challengeId:'anything',code:'123456'})).status,410);
  assert.equal((await req('/config')).data.sms,false);
  assert.equal((await req('/auth/google/challenge',{},'',{Origin:'https://evil.example'})).status,403);
  const c=await challenge(),token=googleToken(c.data.nonce);
  assert.equal((await req('/auth/google',{credential:token})).status,401);
  assert.equal((await req('/auth/google',{credential:googleToken('wrong')},c.cookie)).status,401);
  for(const overrides of [{aud:'evil'},{iss:'https://evil.example'},{exp:Math.floor(Date.now()/1000)-600},{email_verified:false},{sub:''}]){
   assert.equal((await req('/auth/google',{credential:googleToken(c.data.nonce,overrides)},c.cookie)).status,401);
  }
  const parts=token.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  assert.equal((await req('/auth/google',{credential:parts.join('.')},c.cookie)).status,401);
  const first=await req('/auth/google',{credential:token},c.cookie);assert.equal(first.status,200);assert.equal(first.data.user.admin,false);
  assert.equal((await req('/auth/google',{credential:token},c.cookie)).status,401);
  await req('/profile',{role:'student',name:'Google Learner',age:20,domain:'Coding lessons'},first.cookie);
  const again=await login();assert.equal(again.data.user.id,first.data.user.id);assert.equal(again.data.user.balance.silver,60);
  const changed=await login({email:'changed@gmail.com'});assert.equal(changed.data.user.id,first.data.user.id);assert.equal(changed.data.user.balance.silver,60);
  const other=await login({sub:'different-user'});assert.notEqual(other.data.user.id,first.data.user.id);
  const admin=await login({sub:'owner',email:'owner@gmail.com'});assert.equal(admin.data.user.admin,true);
  const expired=await challenge();a.store.run('UPDATE google_challenges SET expires_at=0');assert.equal((await req('/auth/google',{credential:googleToken(expired.data.nonce)},expired.cookie)).status,401);
  await req('/auth/logout',{},again.cookie);assert.equal((await req('/me',null,again.cookie)).data.user,null);
 }finally{restore();await new Promise(r=>server.close(r));a.close();rmSync(dir,{recursive:true,force:true});}
});
test('production starts with Google credentials and no Twilio credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ss-google-prod-'));
 try{const a=createApp({NODE_ENV:'production',APP_ORIGIN:'https://example.com',DATA_ENCRYPTION_KEY:'x'.repeat(32),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',DB_PATH:join(dir,'db')});a.close();}
 finally{rmSync(dir,{recursive:true,force:true});}
});
