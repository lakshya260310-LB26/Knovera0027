import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {issue} from './domain.mjs';

export function validSignature(body,signature,secret) {
  if(!secret || !/^[a-f0-9]{64}$/i.test(signature||''))return false;
  return timingSafeEqual(createHmac('sha256',secret).update(body).digest(),Buffer.from(signature,'hex'));
}
export async function razorpay(env,path,body,payout=false,idempotency) {
  const prefix=payout?'RAZORPAYX':'RAZORPAY';
  const response=await fetch(`https://api.razorpay.com/v1/${path}`,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(`${env[prefix+'_KEY_ID']}:${env[prefix+'_KEY_SECRET']}`).toString('base64'),'Content-Type':'application/json',...(idempotency?{'X-Payout-Idempotency':idempotency}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!response.ok){
    const result=await response.json().catch(()=>({}));const error=issue(502,'The payment provider could not confirm this request. Please check its status before trying again.');
    // A definite first-request validation rejection can release funds. A timeout or
    // idempotency conflict cannot prove that no transfer was already accepted.
    error.definiteRejection=[400,422].includes(response.status)&&!JSON.stringify(result.error||{}).toLowerCase().includes('idempotenc');throw error;
  }
  return response.json();
}

// Only matched join/leave intervals count. Duplicate joins do not multiply time.
export function attendedMinutes(session,events,studentId) {
  const start=session.starts_at,end=start+session.duration*60000;
  function intervals(id) {
    let joined=null,incomplete=false;const result=[];
    for(const e of events.filter(e=>e.user_id===id).sort((a,b)=>a.at-b.at || (a.event==='participant_joined'?-1:1))) {
      if(e.event==='participant_joined'){if(joined===null)joined=e.at;}
      else if(e.event==='participant_left' && joined!==null){const a=Math.max(start,joined),b=Math.min(end,e.at);if(b>a)result.push([a,b]);joined=null;}
    }
    if(joined!==null && joined<end)incomplete=true;
    return {result,incomplete};
  }
  const teacher=intervals(session.teacher_id),student=intervals(studentId);let total=0;
  for(const [a,b] of teacher.result)for(const [c,d] of student.result)total+=Math.max(0,Math.min(b,d)-Math.max(a,c));
  return {minutes:Math.min(session.duration,Math.floor(total/60000)),incomplete:teacher.incomplete||student.incomplete};
}

export function createFinance(store,env,codec) {
  const {db,get,all,run,transaction,credit,log}=store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_orders(order_id TEXT PRIMARY KEY REFERENCES orders(id),provider_order TEXT UNIQUE NOT NULL,payment_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS earnings(booking_id TEXT PRIMARY KEY REFERENCES bookings(id),teacher_id TEXT NOT NULL,session_id TEXT NOT NULL,minutes INTEGER NOT NULL,rate INTEGER NOT NULL,amount INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payout_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),private_data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL,private_data TEXT NOT NULL,provider_id TEXT UNIQUE,fund_account_id TEXT,request_body TEXT,status TEXT NOT NULL DEFAULT 'preparing',utr TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payout_attempts(payout_id TEXT PRIMARY KEY REFERENCES payouts(id),attempts INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_payout ON payouts(user_id) WHERE status NOT IN ('processed','failed','reversed','rejected','cancelled');
    CREATE INDEX IF NOT EXISTS earnings_teacher ON earnings(teacher_id);
  `);
  const payments=env.PAYMENTS_ENABLED==='true'&&!!(env.RAZORPAY_KEY_ID&&env.RAZORPAY_KEY_SECRET&&env.RAZORPAY_WEBHOOK_SECRET);
  const payouts=env.PAYOUTS_ENABLED==='true'&&!!(env.RAZORPAYX_KEY_ID&&env.RAZORPAYX_KEY_SECRET&&env.RAZORPAYX_ACCOUNT_NUMBER&&env.RAZORPAYX_WEBHOOK_SECRET);
  if(env.NODE_ENV==='production' && ((payments&&!env.RAZORPAY_KEY_ID.startsWith('rzp_live_'))||(payouts&&!env.RAZORPAYX_KEY_ID.startsWith('rzp_live_'))))throw new Error('Production requires live Razorpay keys.');
  const inactive=['failed','reversed','rejected','cancelled'];
  function summary(id){
    const available=get("SELECT COALESCE(SUM(amount),0) n FROM earnings WHERE teacher_id=? AND state='available'",id).n;
    const held=get("SELECT COALESCE(SUM(amount),0) n FROM earnings WHERE teacher_id=? AND state='held'",id).n;
    const rows=all('SELECT id,amount,status,utr,created_at,updated_at FROM payouts WHERE user_id=? ORDER BY created_at DESC',id);
    const paid=rows.filter(p=>p.status==='processed').reduce((n,p)=>n+p.amount,0);
    const processing=rows.filter(p=>!inactive.includes(p.status)&&p.status!=='processed').reduce((n,p)=>n+p.amount,0);
    const profile=get('SELECT private_data FROM payout_profiles WHERE user_id=?',id);
    return {available:available-paid-processing,held,paid,processing,payouts:rows,profile:profile?codec.open(profile.private_data):null,enabled:payouts,history:all(`SELECT s.id,s.title,s.starts_at,s.duration,s.format,s.status,(SELECT COUNT(*) FROM bookings b WHERE b.session_id=s.id) students,COALESCE(SUM(e.minutes),0) minutes,COALESCE(SUM(e.amount),0) amount,CASE WHEN SUM(CASE WHEN e.state='held' THEN 1 ELSE 0 END)>0 THEN 'held' ELSE 'available' END earningStatus FROM sessions s LEFT JOIN earnings e ON e.session_id=s.id WHERE s.teacher_id=? GROUP BY s.id ORDER BY s.starts_at DESC`,id)};
  }
  function accrue(session,state) {
    const events=all('SELECT * FROM attendance WHERE session_id=? ORDER BY at',session.id);
    for(const b of all('SELECT * FROM bookings WHERE session_id=?',session.id)) {
      const attendance=attendedMinutes(session,events,b.user_id),rate=session.format==='group'?90:180;
      run(`INSERT INTO earnings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET minutes=excluded.minutes,amount=excluded.amount,state=excluded.state WHERE earnings.state='held'`,b.id,session.teacher_id,session.id,attendance.minutes,rate,attendance.minutes*rate,attendance.incomplete?'held':state,Date.now());
    }
  }
  function hold(sessionId){run("UPDATE earnings SET state='held' WHERE session_id=?",sessionId);}
  function fulfill(payment) {
    return transaction(()=>{
      const o=get('SELECT o.*,g.provider_order,g.payment_id FROM orders o JOIN gateway_orders g ON g.order_id=o.id WHERE g.provider_order=?',payment.order_id);
      if(!o)throw issue(404,'Unknown payment order.');
      if(payment.status!=='captured'||payment.captured!==true||payment.currency!=='INR'||payment.amount!==o.price*100||!/^pay_[A-Za-z0-9]+$/.test(payment.id||''))throw issue(409,'Payment is not yet captured for the correct amount. Your credits have not been changed.');
      if(o.payment_id){if(o.payment_id!==payment.id)throw issue(409,'Order already has a different payment.');return o;}
      run('UPDATE gateway_orders SET payment_id=? WHERE order_id=?',payment.id,o.id);
      credit(o.user_id,o.kind,o.credits,`order:${o.id}`,`Purchased ${o.credits} ${o.kind} credits`);
      run("UPDATE orders SET status='approved' WHERE id=?",o.id);log('gateway','payment_captured',{orderId:o.id,paymentId:payment.id,paise:payment.amount});return o;
    });
  }
  function reserve(user) {
    return transaction(()=>{
      const open=get("SELECT * FROM payouts WHERE user_id=? AND status NOT IN ('processed','failed','reversed','rejected','cancelled')",user.id);
      if(open)return open;
      const s=summary(user.id);if(!s.profile)throw issue(400,'Save your UPI ID before redeeming.');
      if(s.available<100)throw issue(409,'At least ₹1 of verified earnings is needed to redeem.');
      const id=randomUUID();run('INSERT INTO payouts(id,user_id,amount,private_data,created_at,updated_at) VALUES(?,?,?,?,?,?)',id,user.id,s.available,codec.seal(s.profile),Date.now(),Date.now());
      log(user.id,'redemption_requested',{payoutId:id,paise:s.available});return get('SELECT * FROM payouts WHERE id=?',id);
    });
  }
  function applyPayout(p,entity){
    if(entity.reference_id!==p.id||entity.amount!==p.amount||entity.currency!=='INR'||entity.fund_account_id!==p.fund_account_id||!/^pout_[A-Za-z0-9]+$/.test(entity.id||''))throw issue(409,'Payout confirmation does not match this redemption.');
    const statuses=['queued','pending','processing','processed','failed','reversed','rejected','cancelled'];
    if(!statuses.includes(entity.status))throw issue(409,'Unrecognised payout state.');
    transaction(()=>{
      const current=get('SELECT * FROM payouts WHERE id=?',p.id);
      // A processed payout may later be reversed; older notifications cannot undo it.
      if(inactive.includes(current.status)||(current.status==='processed'&&entity.status!=='reversed'))return;
      if(current.provider_id&&current.provider_id!==entity.id)throw issue(409,'Payout ID mismatch.');
      run('UPDATE payouts SET provider_id=?,status=?,utr=?,updated_at=? WHERE id=?',entity.id,entity.status,entity.utr||null,Date.now(),p.id);
      log('gateway','payout_status',{payoutId:p.id,status:entity.status});
    });
  }
  const busy=new Set();
  async function processPayout(id) {
    if(busy.has(id)||!payouts)return;
    busy.add(id);let attempted=0;
    try{
      let p=get('SELECT * FROM payouts WHERE id=?',id);if(!p||inactive.includes(p.status)||p.status==='processed')return;
      if(p.provider_id){applyPayout(p,await razorpay(env,`payouts/${p.provider_id}`,null,true));return;}
      const profile=codec.open(p.private_data);
      if(!p.fund_account_id){
        const contact=await razorpay(env,'contacts',{name:profile.name,type:'vendor',reference_id:p.user_id},true);
        const account=await razorpay(env,'fund_accounts',{account_type:'vpa',contact_id:contact.id,vpa:{address:profile.upi}},true);
        run('UPDATE payouts SET fund_account_id=? WHERE id=?',account.id,id);p=get('SELECT * FROM payouts WHERE id=?',id);
      }
      if(!p.request_body){
        const body={account_number:env.RAZORPAYX_ACCOUNT_NUMBER,fund_account_id:p.fund_account_id,amount:p.amount,currency:'INR',mode:'UPI',purpose:'payout',queue_if_low_balance:true,reference_id:p.id,narration:'SkillSwap teaching'};
        run("UPDATE payouts SET request_body=?,status='processing',updated_at=? WHERE id=?",codec.seal(body),Date.now(),id);p=get('SELECT * FROM payouts WHERE id=?',id);
      }
      run('INSERT INTO payout_attempts VALUES(?,1) ON CONFLICT(payout_id) DO UPDATE SET attempts=attempts+1',id);attempted=get('SELECT attempts FROM payout_attempts WHERE payout_id=?',id).attempts;
      const response=await razorpay(env,'payouts',codec.open(p.request_body),true,p.id);applyPayout(p,response);
    }catch(error){const saved=get('SELECT * FROM payouts WHERE id=?',id);if(error.definiteRejection&&saved&&!saved.provider_id&&(!saved.request_body||attempted===1)){run("UPDATE payouts SET status='rejected',updated_at=? WHERE id=?",Date.now(),id);log('system','payout_rejected',{payoutId:id});}else log('system','payout_reconciliation_needed',{payoutId:id});/* Ambiguous failures stay reserved. Retry SAME key/body only. */}
    finally{busy.delete(id);}
  }
  let reconciling=false;
  async function reconcile(){if(reconciling)return;reconciling=true;try{for(const p of all("SELECT id FROM payouts WHERE status NOT IN ('processed','failed','reversed','rejected','cancelled') ORDER BY updated_at LIMIT 20"))await processPayout(p.id);}finally{reconciling=false;}}
  return {payments,payouts,summary,accrue,hold,fulfill,reserve,processPayout,applyPayout,reconcile};
}
