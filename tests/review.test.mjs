import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {privateCodec} from '../server/services.mjs';

async function scenario(report,{audio=true,failure=false}={}) {
  const dir=mkdtempSync(join(tmpdir(),'ss-review-'));const secret='test-encryption-secret';const codec=privateCodec(secret);
  const a=createApp({NODE_ENV:'test',DB_PATH:join(dir,'db.sqlite'),DATA_ENCRYPTION_KEY:secret,OPENAI_API_KEY:'test-only-never-sent'});
  const db=a.store;const teacher=randomUUID(),student=randomUUID(),id=randomUUID(),booking=randomUUID();const starts=Date.now()-40*60000;
  db.run('INSERT INTO users(id,phone_hash,private_data,role,name,created_at) VALUES(?,?,?,?,?,?)',teacher,'teacher',codec.seal({phone:'demo'}),'teacher','Test Teacher',starts);
  db.run('INSERT INTO users(id,phone_hash,private_data,role,name,created_at) VALUES(?,?,?,?,?,?)',student,'student',codec.seal({phone:'demo'}),'student','Test Student',starts);
  db.run('INSERT INTO sessions(id,teacher_id,title,domain,subject,format,starts_at,duration,capacity,description,topics,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,teacher,'Test lesson','Coding lessons','Python','group',starts,30,5,'Test teaching',JSON.stringify(['Variables','Loops']),starts);
  db.run('INSERT INTO bookings(id,user_id,session_id,kind,cost,created_at) VALUES(?,?,?,?,?,?)',booking,student,id,'silver',30,starts);
  db.credit(student,'silver',60,'gift','Test grant');db.credit(student,'silver',-30,`book:${booking}`,'Reserved lesson');
  for(const [user,event,at] of [[teacher,'participant_joined',starts],[student,'participant_joined',starts],[teacher,'participant_left',starts+30*60000],[student,'participant_left',starts+30*60000]])db.run('INSERT INTO attendance VALUES(?,?,?,?,?)',randomUUID(),id,user,event,at);
  if(audio)for(let i=0;i<30;i++)db.run('INSERT INTO transcripts VALUES(?,?,?,?,?)',randomUUID(),id,teacher,codec.seal({text:'This is test lesson evidence about variables and loops.'}),starts+i*60000);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');const payload=JSON.parse(options.body);assert.equal(payload.store,false);assert.equal(payload.text.format.type,'json_schema');if(failure)return new Response('{}',{status:503});return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(report)}]}]});};
  try{await a.finalize(id);await a.finalize(id);return {cash:a.finance.summary(teacher),balance:db.balances(student),session:db.get('SELECT * FROM sessions WHERE id=?',id),earned:db.get('SELECT earned FROM users WHERE id=?',teacher).earned,refunds:db.get("SELECT COUNT(*) n FROM ledger WHERE event_key LIKE 'refund:%'").n};}
  finally{globalThis.fetch=originalFetch;a.close();rmSync(dir,{recursive:true,force:true});}
}
const good={summary:'Topics covered.',coverage:[{topic:'Variables',covered:true,evidence:'Example'}],issues:[],needs_review:false};
test('high confidence teaching issue refunds full cost once without reducing teacher minutes',async()=>{const r=await scenario({...good,issues:[{type:'incomplete_coverage',description:'Loops were not covered.',evidence:'Complete transcript lacks the agreed lesson.',confidence:.95}]});assert.equal(r.session.status,'refunded');assert.equal(r.balance.silver,60);assert.equal(r.refunds,1);assert.equal(r.earned,30);assert.equal(r.cash.available,0);assert.equal(r.cash.held,2700);});
test('possible fraud requires review even if model omits its review flag',async()=>{const r=await scenario({...good,issues:[{type:'possible_fraud',description:'Requires investigation',evidence:'Insufficient',confidence:.95}]});assert.equal(r.session.status,'review');assert.equal(r.balance.silver,30);assert.equal(r.refunds,0);});
test('successful review keeps booking cost and awards verified minutes once',async()=>{const r=await scenario(good);assert.equal(r.session.status,'completed');assert.equal(r.earned,30);assert.equal(r.balance.silver,30);assert.equal(r.cash.available,2700);assert.equal(r.cash.held,0);});
test('missing audio fails to manual review rather than pretending verification succeeded',async()=>{const r=await scenario(good,{audio:false});assert.equal(r.session.status,'review');assert.equal(r.earned,0);assert.equal(r.refunds,0);});
test('AI provider failure fails to manual review',async()=>{const r=await scenario(good,{failure:true});assert.equal(r.session.status,'review');assert.equal(r.balance.silver,30);});
