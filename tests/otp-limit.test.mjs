import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.mjs';

test('five incorrect OTP attempts exhaust an isolated challenge',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ss-otp-'));
  const a=createApp({NODE_ENV:'test',DEMO_MODE:'true',DB_PATH:join(dir,'db.sqlite')});
  const server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const post=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/auth/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-SkillSwap-Request':'1'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  try{const sent=await post('send',{phone:'+919000000011'});assert.equal(sent.status,200);
    for(let i=0;i<5;i++)assert.equal((await post('verify',{challengeId:sent.data.challengeId,code:'000000'})).status,400);
    assert.equal(a.store.get('SELECT attempts FROM challenges WHERE id=?',sent.data.challengeId).attempts,5);
    assert.equal((await post('verify',{challengeId:sent.data.challengeId,code:'246810'})).status,400);
  }finally{await new Promise(r=>server.close(r));a.close();rmSync(dir,{recursive:true,force:true});}
});
