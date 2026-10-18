import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {issue, kindFor} from './domain.mjs';

export function createStore(path) {
  mkdirSync(dirname(path), {recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, phone_hash TEXT UNIQUE NOT NULL, private_data TEXT NOT NULL, role TEXT, name TEXT, degree TEXT, field TEXT, domain TEXT, earned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS logins(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, private_data TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('silver','gold')), amount INTEGER NOT NULL, event_key TEXT UNIQUE NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, domain TEXT NOT NULL, subject TEXT NOT NULL, format TEXT NOT NULL, starts_at INTEGER NOT NULL, duration INTEGER NOT NULL, capacity INTEGER NOT NULL, description TEXT NOT NULL, topics TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', report TEXT, teacher_awarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, cost INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'booked', consent_at INTEGER, created_at INTEGER NOT NULL, UNIQUE(user_id, session_id));
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, credits INTEGER NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_payment', utr TEXT UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attendance(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS transcripts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consents(session_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,user_id));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
    CREATE INDEX IF NOT EXISTS sessions_start ON sessions(starts_at);
    CREATE INDEX IF NOT EXISTS transcript_session ON transcripts(session_id);
  `);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try {const result=fn(); db.exec('COMMIT'); return result;} catch(e){db.exec('ROLLBACK');throw e;} }
  function balances(id) {const result={silver:0,gold:0};for(const row of all('SELECT kind, SUM(amount) AS amount FROM ledger WHERE user_id=? GROUP BY kind',id))result[row.kind]=row.amount;return result;}
  function credit(id,kind,amount,event,description) { run('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)',randomUUID(),id,kind,amount,event,description,Date.now()); }
  function log(actor,action,detail){run('INSERT INTO audit VALUES(?,?,?,?,?)',randomUUID(),actor,action,JSON.stringify(detail),Date.now());}
  function book(user,sessionId) {
    return transaction(()=>{
      if(user.role!=='student')throw issue(403,'Only student accounts can book a session.');
      const session=get('SELECT * FROM sessions WHERE id=?',sessionId);
      if(!session || session.status!=='scheduled' || session.starts_at<=Date.now())throw issue(409,'This session is no longer available to book.');
      if(get('SELECT id FROM bookings WHERE user_id=? AND session_id=?',user.id,sessionId))throw issue(409,'You already reserved this session.');
      const count=get("SELECT COUNT(*) AS n FROM bookings WHERE session_id=? AND status='booked'",sessionId).n;
      if(count>=session.capacity)throw issue(409,'This session is full. Please choose another.');
      const conflict=get("SELECT b.id FROM bookings b JOIN sessions s ON s.id=b.session_id WHERE b.user_id=? AND b.status='booked' AND s.status='scheduled' AND s.starts_at<? AND s.starts_at+s.duration*60000>?",user.id,session.starts_at+session.duration*60000,session.starts_at);
      if(conflict)throw issue(409,'You already have a session at this time.');
      const kind=kindFor(session.format);
      if(balances(user.id)[kind]<session.duration)throw issue(409,`You need ${session.duration} ${kind} credits. Top up your wallet first.`);
      const id=randomUUID();
      run('INSERT INTO bookings(id,user_id,session_id,kind,cost,created_at) VALUES(?,?,?,?,?,?)',id,user.id,sessionId,kind,session.duration,Date.now());
      credit(user.id,kind,-session.duration,`book:${id}`,`Reserved: ${session.title}`);
      return {id,kind,cost:session.duration};
    });
  }
  function refundSession(sessionId,reason) {
    for(const b of all("SELECT * FROM bookings WHERE session_id=? AND status='booked'",sessionId)) {
      credit(b.user_id,b.kind,b.cost,`refund:${b.id}`,`Full session refund: ${reason}`);
      run("UPDATE bookings SET status='refunded' WHERE id=?",b.id);
    }
  }
  function approveOrder(orderId,actor,bankReference) {
    return transaction(()=>{
      const o=get('SELECT * FROM orders WHERE id=?',orderId);
      if(!o)throw issue(404,'Order not found.');
      if(o.status==='approved')return o;
      if(o.status!=='pending_review')throw issue(409,'This order is not awaiting review.');
      if(o.utr!==bankReference)throw issue(400,'The verified bank reference must match the submitted UTR.');
      credit(o.user_id,o.kind,o.credits,`order:${o.id}`,`Purchased ${o.credits} ${o.kind} credits`);
      run("UPDATE orders SET status='approved' WHERE id=?",o.id);
      log(actor,'payment_approved',{orderId,bankReference,price:o.price});
      return {...o,status:'approved'};
    });
  }
  return {db,get,all,run,transaction,balances,credit,log,book,refundSession,approveOrder};
}
