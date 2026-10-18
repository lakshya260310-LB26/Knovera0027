import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import QRCode from 'qrcode';
import {AccessToken,WebhookReceiver,RoomServiceClient} from 'livekit-server-sdk';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {createStore} from './store.mjs';
import {createFinance,razorpay,validSignature} from './finance.mjs';
import {DOMAINS,DEGREES,PACKS,priceFor,issue,publicProfile} from './domain.mjs';
import {privateCodec,hash,transcribe,assess} from './services.mjs';

import {verifyGoogleCredential} from './google-auth.mjs';

const validText=(max=120)=>z.string().trim().min(2).max(max);
const phoneSchema=z.string().regex(/^\+91[6-9]\d{9}$/,'Enter a valid Indian mobile number.');
const sessionSchema=z.object({title:validText(100),domain:z.enum(DOMAINS),subject:validText(100),format:z.enum(['group','one']),startsAt:z.string().datetime(),duration:z.coerce.number().int().min(15).max(120),capacity:z.coerce.number().int().min(1).max(30),description:validText(1000),topics:z.array(validText(180)).min(1).max(10)});

export function createApp(env=process.env) {
  env={...env,APP_ORIGIN:env.APP_ORIGIN || env.RENDER_EXTERNAL_URL};
  const production=env.NODE_ENV==='production';
  const demo=!production && env.DEMO_MODE==='true';
  const secret=env.DATA_ENCRYPTION_KEY || (!production?'local-demo-only-change-before-deploy':null);
  if(!secret || (production && secret.length<32))throw new Error('DATA_ENCRYPTION_KEY must contain at least 32 random characters in production.');
  if(production && (!env.APP_ORIGIN || !env.APP_ORIGIN.startsWith('https://')))throw new Error('Set APP_ORIGIN to your exact HTTPS Render URL.');
  const sms=false;
  const googleClientId=env.GOOGLE_CLIENT_ID || '';
  if(production && !googleClientId)throw new Error('Production login requires GOOGLE_CLIENT_ID. Demo login is never available in production.');
  const video=!!(env.LIVEKIT_URL&&env.LIVEKIT_API_KEY&&env.LIVEKIT_API_SECRET);
  const ai=!!env.OPENAI_API_KEY;
  const store=createStore(env.DB_PATH || resolve(demo?'data/preview.sqlite':'data/live.sqlite'));
  const {get,all,run,transaction,credit,balances,log}=store;
  store.db.exec('CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const prior=get("SELECT value FROM app_meta WHERE key='mode'");
  if((prior&&prior.value!==(demo?'demo':'live'))||(!prior&&!demo&&get('SELECT COUNT(*) n FROM users').n>0)){store.db.close();throw new Error('Use a separate empty database for live service. Demo accounts and balances cannot become real money.');}
  run("INSERT OR IGNORE INTO app_meta VALUES('mode',?)",demo?'demo':'live');
  store.db.exec('CREATE TABLE IF NOT EXISTS google_challenges(id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  const codec=privateCodec(secret);
  const finance=createFinance(store,env,codec);
  const payments=!demo&&finance.payments;
  const manualPayments=!demo&&env.MANUAL_UPI_ENABLED==='true'&&!!env.ADMIN_EMAIL;
  const upiId=env.UPI_ID || '9680877599@ybl';
  const phoneHash=phone=>createHmac('sha256',secret).update(phone).digest('hex');
  const app=express(); app.disable('x-powered-by');
  if(production)app.set('trust proxy',1);
  app.use(helmet({crossOriginOpenerPolicy:{policy:'same-origin-allow-popups'},contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://checkout.razorpay.com','https://accounts.google.com/gsi/client'],styleSrc:["'self'","'unsafe-inline'",'https://accounts.google.com/gsi/style'],imgSrc:["'self'",'data:','blob:'],connectSrc:["'self'",'wss:','https://*.livekit.cloud','https://api.razorpay.com','https://checkout.razorpay.com','https://accounts.google.com/gsi/'],frameSrc:['https://api.razorpay.com','https://checkout.razorpay.com','https://accounts.google.com/gsi/'],mediaSrc:["'self'",'blob:'],workerSrc:["'self'",'blob:'],frameAncestors:["'none'"],upgradeInsecureRequests:production?[]:null}},strictTransportSecurity:production?undefined:false}));
  app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many requests. Please wait a minute.'}}));

  app.post('/api/livekit/webhook',express.raw({type:()=>true,limit:'1mb'}),async(req,res)=>{
    if(!video)return res.sendStatus(503);
    try{
      const event=await new WebhookReceiver(env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET).receive(req.body.toString(),req.get('authorization'));
      if(['participant_joined','participant_left'].includes(event.event)&&event.room?.name?.startsWith('ss-')&&event.participant?.identity){
        run('INSERT OR IGNORE INTO attendance VALUES(?,?,?,?,?)',event.id,event.room.name.slice(3),event.participant.identity,event.event,Number(event.createdAt)*1000);
      }
      res.sendStatus(200);
    }catch{res.sendStatus(401);}
  });
  // Provider signatures cover the original bytes, before JSON parsing and browser CSRF checks.
  app.post('/api/payments/webhook',express.raw({type:()=>true,limit:'256kb'}),async(req,res)=>{
    if(!payments)return res.sendStatus(503);
    if(!validSignature(req.body,req.get('x-razorpay-signature'),env.RAZORPAY_WEBHOOK_SECRET))return res.sendStatus(401);
    try{const event=JSON.parse(req.body.toString());if(['payment.captured','order.paid'].includes(event.event)){const entity=event.payload?.payment?.entity;if(entity){const known=get('SELECT order_id FROM gateway_orders WHERE provider_order=?',entity.order_id);if(known)finance.fulfill(entity);}}res.sendStatus(200);}catch{res.sendStatus(400);}
  });
  app.post('/api/payouts/webhook',express.raw({type:()=>true,limit:'256kb'}),async(req,res)=>{
    if(demo||!finance.payouts)return res.sendStatus(503);
    if(!validSignature(req.body,req.get('x-razorpay-signature'),env.RAZORPAYX_WEBHOOK_SECRET))return res.sendStatus(401);
    try{const event=JSON.parse(req.body.toString());const entity=event.payload?.payout?.entity;const p=entity&&get('SELECT * FROM payouts WHERE id=?',entity.reference_id);if(p){const current=await razorpay(env,`payouts/${entity.id}`,null,true);finance.applyPayout(p,current);}res.sendStatus(200);}catch{res.sendStatus(503);}
  });
  app.use(express.json({limit:'32kb'}));
  app.use('/api',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const origin=req.get('origin');
      const expected=env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if((origin && origin!==expected)||req.get('sec-fetch-site')==='cross-site')return next(issue(403,'This request must originate from Knovera.'));
      if(!req.get('x-skillswap-request'))return next(issue(403,'Missing request verification.'));
    }
    const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ss_session='))?.slice(11);
    if(raw){const login=get('SELECT * FROM logins WHERE token_hash=? AND expires_at>?',hash(raw),Date.now());if(login)req.user=get('SELECT * FROM users WHERE id=?',login.user_id);}
    next();
  });
  const auth=(req,res,next)=>req.user?next():next(issue(401,'Please sign in to continue.'));
  const isAdmin=u=>{if(!u)return false;const d=codec.open(u.private_data);return demo?!!env.ADMIN_PHONE&&u.phone_hash===phoneHash(env.ADMIN_PHONE):!!env.ADMIN_EMAIL&&d.googleEmailTrusted===true&&d.email?.toLowerCase()===env.ADMIN_EMAIL.trim().toLowerCase();};
  const admin=(req,res,next)=>isAdmin(req.user)?next():next(issue(403,'An administrator account is required.'));
  const fullUser=u=>u?{...publicProfile(u),balance:balances(u.id),welcome:!!get('SELECT id FROM ledger WHERE event_key=?',`welcome:${u.id}`),admin:isAdmin(u),email:codec.open(u.private_data).email,phone:codec.open(u.private_data).phone?.replace(/.(?=.{4})/g,'•')}:null;
  function signIn(res,user) {const token=randomBytes(32).toString('hex');run('INSERT INTO logins VALUES(?,?,?)',hash(token),user.id,Date.now()+7*86400000);res.cookie('ss_session',token,{httpOnly:true,secure:production,sameSite:'strict',maxAge:7*86400000,path:'/'});}
  function userForPhone(phone) {const existing=get('SELECT * FROM users WHERE phone_hash=?',phoneHash(phone));if(existing)return existing;const id=randomUUID();run('INSERT INTO users(id,phone_hash,private_data,created_at) VALUES(?,?,?,?)',id,phoneHash(phone),codec.seal({phone}),Date.now());return get('SELECT * FROM users WHERE id=?',id);}
  function welcomeSlots(){const cap=Math.max(0,Number(env.WELCOME_SLOT_LIMIT || 100));const claimed=get("SELECT COUNT(*) AS n FROM ledger WHERE event_key LIKE 'welcome:%'").n;return Math.max(0,cap-claimed);}
  function joinedSession(row) {return {...row,topics:JSON.parse(row.topics),report:row.report?JSON.parse(row.report):null,teacher:publicProfile(get('SELECT * FROM users WHERE id=?',row.teacher_id)),booked:get("SELECT COUNT(*) AS n FROM bookings WHERE session_id=? AND status='booked'",row.id).n};}
  app.get('/api/config',(req,res)=>res.json({demo,sms,googleClientId:demo?null:googleClientId,video,ai,payments,manualPayments,payouts:!demo&&finance.payouts,domains:DOMAINS,degrees:DEGREES,packs:PACKS,welcomeSlots:welcomeSlots(),upi:env.UPI_ID || '9680877599@ybl'}));
  app.get('/api/me',(req,res)=>res.json({user:fullUser(req.user)}));
  app.get('/healthz',(req,res)=>res.json({ok:true}));
  const otpLimit=rateLimit({windowMs:10*60000,limit:20,message:{error:'Please wait before requesting another code.'},standardHeaders:'draft-8',legacyHeaders:false});
  const googleLimit=rateLimit({windowMs:10*60000,limit:30,message:{error:'Please wait before trying Google sign-in again.'},standardHeaders:'draft-8',legacyHeaders:false});
  app.post('/api/auth/google/challenge',googleLimit,(req,res)=>{
    if(demo||!googleClientId)throw issue(503,'Google sign-in is awaiting configuration.');
    run('DELETE FROM google_challenges WHERE expires_at<?',Date.now());
    const id=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('hex');
    run('INSERT INTO google_challenges VALUES(?,?,?)',hash(id),hash(nonce),Date.now()+10*60000);
    res.cookie('ss_google',id,{httpOnly:true,secure:production,sameSite:'strict',maxAge:10*60000,path:'/api/auth/google'});
    res.json({nonce});
  });
  app.post('/api/auth/google',googleLimit,async(req,res)=>{
    if(demo||!googleClientId)throw issue(503,'Google sign-in is awaiting configuration.');
    const {credential}=z.object({credential:z.string().min(1).max(16000)}).parse(req.body);
    const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ss_google='))?.slice(10);
    const challenge=raw&&get('SELECT * FROM google_challenges WHERE id=? AND expires_at>?',hash(raw),Date.now());
    if(!challenge)throw issue(401,'Google sign-in expired. Please refresh and try again.');
    const profile=await verifyGoogleCredential(credential,googleClientId);
    if(typeof profile.nonce!=='string'||hash(profile.nonce)!==challenge.nonce_hash)throw issue(401,'Google sign-in could not be verified.');
    if(!run('DELETE FROM google_challenges WHERE id=? AND expires_at>?',challenge.id,Date.now()).changes)throw issue(401,'Google sign-in expired or was already used.');
    res.clearCookie('ss_google',{path:'/api/auth/google'});
    // Stable Google subject, never email or an unverified phone, identifies the account.
    const identity=phoneHash('google:'+profile.sub);
    let user=get('SELECT * FROM users WHERE phone_hash=?',identity);
    const details={...(user?codec.open(user.private_data):{}),email:profile.email,googleEmailTrusted:profile.email_verified===true&&(profile.email.endsWith('@gmail.com')||!!profile.hd)};
    if(!user){const id=randomUUID();run('INSERT INTO users(id,phone_hash,private_data,created_at) VALUES(?,?,?,?)',id,identity,codec.seal(details),Date.now());user=get('SELECT * FROM users WHERE id=?',id);}
    else {run('UPDATE users SET private_data=? WHERE id=?',codec.seal(details),user.id);user=get('SELECT * FROM users WHERE id=?',user.id);}
    signIn(res,user);res.json({user:fullUser(user)});
  });
  app.post('/api/auth/send',otpLimit,async(req,res)=>{
    if(!demo)throw issue(410,'SMS sign-in has been replaced by Continue with Google.');
    const phone=phoneSchema.parse(req.body.phone);
    const recent=get('SELECT COUNT(*) AS n FROM challenges WHERE phone_hash=? AND expires_at>?',phoneHash(phone),Date.now()).n;
    if(recent>=3)throw issue(429,'Please wait 10 minutes before requesting another code.');
    if(demo && !/^\+9190000000\d{2}$/.test(phone))throw issue(400,'In this demo, use a sample number from 9000000000 to 9000000099. No real phone number is needed.');
    const id=randomUUID();run('INSERT INTO challenges(id,phone_hash,private_data,expires_at) VALUES(?,?,?,?)',id,phoneHash(phone),codec.seal({phone}),Date.now()+10*60000);
    res.json({challengeId:id,demoCode:demo?'246810':undefined});
  });
  app.post('/api/auth/verify',otpLimit,async(req,res)=>{
    if(!demo)throw issue(410,'SMS sign-in has been replaced by Continue with Google.');
    const input=z.object({challengeId:z.string().uuid(),code:z.string().regex(/^\d{6}$/)}).parse(req.body);
    const c=get('SELECT * FROM challenges WHERE id=?',input.challengeId);
    if(!c||c.used||c.expires_at<Date.now()||c.attempts>=5)throw issue(400,'This code has expired. Request a new code.');
    run('UPDATE challenges SET attempts=attempts+1 WHERE id=?',c.id);
    const {phone}=codec.open(c.private_data);
    const approved=input.code==='246810';
    if(!approved)throw issue(400,'That code is incorrect. Please try again.');
    if(!run('UPDATE challenges SET used=1 WHERE id=? AND used=0',c.id).changes)throw issue(409,'This code has already been used.');
    const user=userForPhone(phone);signIn(res,user);res.json({user:fullUser(user)});
  });
  app.post('/api/auth/logout',(req,res)=>{const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ss_session='))?.slice(11);if(raw)run('DELETE FROM logins WHERE token_hash=?',hash(raw));res.clearCookie('ss_session',{path:'/'});res.json({ok:true});});
  app.post('/api/profile',auth,(req,res)=>{
    if(req.user.role)throw issue(409,'Your account profile is already set up.');
    const base=z.object({role:z.enum(['teacher','student']),name:validText(80)}).parse(req.body);
    const details=codec.open(req.user.private_data);
    let degree=null,field=null,domain=null;
    if(base.role==='teacher'){
      const input=z.object({dob:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),address:validText(500),degree:z.enum(DEGREES),field:z.string().trim().max(100).optional()}).parse(req.body);
      const birth=new Date(input.dob+'T00:00:00Z');const age=(Date.now()-birth.getTime())/31557600000;
      if(!Number.isFinite(age)||age<18||age>100)throw issue(400,'Teachers must be at least 18. Please check your date of birth.');
      if(['BTech','MTech','PhD'].includes(input.degree)&&(!input.field||input.field.length<2))throw issue(400,'Please enter your degree field.');
      Object.assign(details,{dob:input.dob,address:input.address});degree=input.degree;field=input.field||null;
    }else{
      const input=z.object({age:z.coerce.number().int().min(5).max(100),domain:z.enum(DOMAINS),guardian:z.boolean().optional()}).parse(req.body);
      if(input.age<18&&!input.guardian)throw issue(400,'A parent or guardian must manage and supervise an under-18 account.');
      Object.assign(details,{age:input.age,guardian:!!input.guardian});domain=input.domain;
    }
    transaction(()=>{
      run('UPDATE users SET role=?,name=?,degree=?,field=?,domain=?,private_data=? WHERE id=?',base.role,base.name,degree,field,domain,codec.seal(details),req.user.id);
      if(base.role==='student'&&welcomeSlots()>0)credit(req.user.id,'silver',60,`welcome:${req.user.id}`,'Welcome gift · 60 minutes of group learning');
    });
    res.json({user:fullUser(get('SELECT * FROM users WHERE id=?',req.user.id))});
  });
  app.get('/api/sessions',auth,(req,res)=>{
    const domain=String(req.query.domain||'');const mine=req.query.mine==='true';
    let rows=mine?all('SELECT * FROM sessions WHERE teacher_id=? ORDER BY starts_at DESC LIMIT 100',req.user.id):all("SELECT * FROM sessions WHERE status='scheduled' AND starts_at>? ORDER BY starts_at LIMIT 300",Date.now());
    if(domain)rows=rows.filter(x=>x.domain===domain);
    res.json({sessions:rows.map(joinedSession)});
  });
  app.post('/api/sessions',auth,(req,res)=>{
    if(req.user.role!=='teacher')throw issue(403,'Only teachers can post session announcements.');
    const s=sessionSchema.parse(req.body);const at=Date.parse(s.startsAt);
    if(at<Date.now()+60000 || at>Date.now()+180*86400000)throw issue(400,'Schedule a session at least one minute ahead and within 180 days.');
    if(get("SELECT id FROM sessions WHERE teacher_id=? AND status='scheduled' AND starts_at<? AND starts_at+duration*60000>?",req.user.id,at+s.duration*60000,at))throw issue(409,'This overlaps with another session you are teaching.');
    const id=randomUUID();run('INSERT INTO sessions(id,teacher_id,title,domain,subject,format,starts_at,duration,capacity,description,topics,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,req.user.id,s.title,s.domain,s.subject,s.format,at,s.duration,s.format==='one'?1:s.capacity,s.description,JSON.stringify(s.topics),Date.now());
    res.status(201).json({session:joinedSession(get('SELECT * FROM sessions WHERE id=?',id))});
  });
  app.post('/api/sessions/:id/book',auth,(req,res)=>res.status(201).json({booking:store.book(req.user,req.params.id),balance:balances(req.user.id)}));
  app.get('/api/bookings',auth,(req,res)=>res.json({bookings:all('SELECT * FROM bookings WHERE user_id=? ORDER BY created_at DESC',req.user.id).map(b=>({...b,session:joinedSession(get('SELECT * FROM sessions WHERE id=?',b.session_id))}))}));
  app.post('/api/sessions/:id/cancel',auth,(req,res)=>{
    transaction(()=>{const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s||s.teacher_id!==req.user.id)throw issue(403,'Only this session’s teacher can cancel.');if(s.status!=='scheduled'||s.starts_at<=Date.now())throw issue(409,'Only a future session can be cancelled.');store.refundSession(s.id,'Teacher cancelled');run("UPDATE sessions SET status='cancelled' WHERE id=?",s.id);log(req.user.id,'session_cancelled',{sessionId:s.id});});res.json({ok:true});
  });
  app.get('/api/wallet',auth,(req,res)=>res.json({balance:balances(req.user.id),ledger:all('SELECT kind,amount,description,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100',req.user.id),orders:all('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30',req.user.id)}));
  app.post('/api/orders',auth,async(req,res)=>{
    if(req.user.role!=='student')throw issue(403,'Credit packs are for student accounts.');
    if(!demo&&!payments&&!manualPayments)throw issue(503,'Payments are not enabled yet. Please check back soon.');
    const input=z.object({kind:z.enum(['silver','gold']),credits:z.number().int()}).parse(req.body);const pack=priceFor(input.kind,input.credits);
    if(!pack)throw issue(400,'Please choose a listed credit pack.');
    const id=randomUUID();run('INSERT INTO orders(id,user_id,kind,credits,price,created_at) VALUES(?,?,?,?,?,?)',id,req.user.id,input.kind,pack.credits,pack.price,Date.now());
    if(!demo&&payments){
      const gateway=await razorpay(env,'orders',{amount:pack.price*100,currency:'INR',receipt:id,partial_payment:false,notes:{skillswap_order:id}});
      if(!gateway.id||gateway.amount!==pack.price*100||gateway.currency!=='INR')throw issue(502,'The payment order could not be verified.');
      run('INSERT INTO gateway_orders(order_id,provider_order) VALUES(?,?)',id,gateway.id);
      return res.status(201).json({order:{id,kind:input.kind,...pack},gateway:{key:env.RAZORPAY_KEY_ID,order_id:gateway.id,amount:pack.price*100,currency:'INR'},demo:false});
    }
    const params=new URLSearchParams({pa:upiId,pn:'Knovera',am:pack.price.toFixed(2),cu:'INR',tn:`Knovera ${id.slice(0,8)}`});
    const uri=demo?`SKILLSWAP DEMO ONLY - DO NOT PAY - ${id}`:`upi://pay?${params}`;
    res.status(201).json({order:{id,kind:input.kind,...pack},qr:await QRCode.toDataURL(uri,{width:320,margin:2,color:{dark:'#10231cff',light:'#ffffffff'}}),uri:demo?null:uri,upi:upiId,manual:!demo,demo});
  });
  app.post('/api/orders/:id/submit',auth,(req,res)=>{
    if(!demo&&!manualPayments)throw issue(410,'Use secure checkout. Manual payment claims are no longer accepted.');
    const utr=z.string().trim().regex(/^\d{12}$/,'Enter the 12-digit UPI transaction reference.').parse(req.body.utr);
    transaction(()=>{const order=get('SELECT * FROM orders WHERE id=? AND user_id=?',req.params.id,req.user.id);if(!order)throw issue(404,'Order not found.');if(get('SELECT order_id FROM gateway_orders WHERE order_id=?',order.id))throw issue(409,'This order uses secure checkout.');if(order.status!=='awaiting_payment')throw issue(409,'This order has already been submitted.');if(get('SELECT id FROM orders WHERE utr=?',utr))throw issue(409,'That payment reference has already been submitted.');run("UPDATE orders SET status='pending_review',utr=? WHERE id=?",utr,order.id);});res.json({status:'pending_review'});
  });
  app.post('/api/orders/:id/verify',auth,async(req,res)=>{
    if(!payments)throw issue(503,'Payments are awaiting activation.');
    const input=z.object({razorpay_payment_id:z.string().regex(/^pay_[A-Za-z0-9]+$/),razorpay_order_id:z.string(),razorpay_signature:z.string()}).parse(req.body);
    const o=get('SELECT g.* FROM gateway_orders g JOIN orders o ON o.id=g.order_id WHERE o.id=? AND o.user_id=?',req.params.id,req.user.id);
    if(!o)throw issue(404,'Order not found.');
    if(input.razorpay_order_id!==o.provider_order||!validSignature(`${o.provider_order}|${input.razorpay_payment_id}`,input.razorpay_signature,env.RAZORPAY_KEY_SECRET))throw issue(400,'Payment signature could not be verified.');
    finance.fulfill(await razorpay(env,`payments/${input.razorpay_payment_id}`));res.json({balance:balances(req.user.id)});
  });
  const teacher=(req,res,next)=>req.user?.role==='teacher'?next():next(issue(403,'A teacher account is required.'));
  app.get('/api/teacher/earnings',auth,teacher,(req,res)=>res.json({...finance.summary(req.user.id),enabled:!demo&&finance.payouts}));
  app.post('/api/teacher/upi',auth,teacher,(req,res)=>{
    const profile=z.object({name:validText(100),upi:z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9.-]+@[a-zA-Z0-9.-]+$/,'Enter a valid UPI ID.')}).parse(req.body);
    run('INSERT INTO payout_profiles VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET private_data=excluded.private_data',req.user.id,codec.seal(profile));log(req.user.id,'payout_profile_updated',{});res.json({ok:true});
  });
  app.post('/api/teacher/redeem',auth,teacher,async(req,res)=>{
    if(demo||!finance.payouts)throw issue(503,'Teacher payouts are awaiting activation.');
    if(req.body.confirm!==true)throw issue(400,'Confirm the UPI destination before redeeming.');
    const current=finance.summary(req.user.id);if(req.body.upi!==current.profile?.upi||req.body.amount!==current.available)throw issue(409,'Your balance or UPI ID changed. Refresh and confirm again.');
    const p=finance.reserve(req.user);await finance.processPayout(p.id);res.status(202).json(finance.summary(req.user.id));
  });
  app.post('/api/admin/sessions/:id/release-earnings',auth,admin,(req,res)=>{
    const reason=validText(500).parse(req.body.reason);
    transaction(()=>{const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s||!['review','refunded','completed'].includes(s.status))throw issue(409,'This lecture is not ready for review.');finance.accrue(s,'available');log(req.user.id,'earnings_review_released',{sessionId:s.id,reason});});res.json({ok:true});
  });
  app.get('/api/admin',auth,admin,(req,res)=>res.json({orders:all("SELECT o.*,u.name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='pending_review' ORDER BY o.created_at"),sessions:all("SELECT * FROM sessions WHERE status='review' OR EXISTS(SELECT 1 FROM earnings e WHERE e.session_id=sessions.id AND e.state='held') ORDER BY starts_at").map(joinedSession)}));
  app.post('/api/admin/orders/:id',auth,admin,(req,res)=>{
    if(!demo&&!manualPayments)throw issue(410,'Credits are issued only after provider confirmation.');
    if(get('SELECT order_id FROM gateway_orders WHERE order_id=?',req.params.id))throw issue(409,'This order uses secure checkout.');
    const input=z.object({decision:z.enum(['approve','reject']),bankVerified:z.boolean(),reference:z.string(),note:validText(500)}).parse(req.body);
    if(input.decision==='approve'){if(!input.bankVerified)throw issue(400,'Confirm receipt in the bank account before approving.');res.json({order:store.approveOrder(req.params.id,req.user.id,input.reference)});}
    else{transaction(()=>{const o=get('SELECT * FROM orders WHERE id=?',req.params.id);if(!o||o.status!=='pending_review')throw issue(409,'This order is not pending.');run("UPDATE orders SET status='rejected' WHERE id=?",o.id);log(req.user.id,'payment_rejected',{orderId:o.id,note:input.note});});res.json({ok:true});}
  });

  function permittedSession(req) {const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s)throw issue(404,'Session not found.');const b=get("SELECT * FROM bookings WHERE user_id=? AND session_id=? AND status='booked'",req.user.id,s.id);if(s.teacher_id!==req.user.id&&!b)throw issue(403,'Reserve this session before joining.');return s;}
  app.get('/api/sessions/:id',auth,(req,res)=>{const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s)throw issue(404,'Session not found.');res.json({session:joinedSession(s)});});
  app.post('/api/sessions/:id/join',auth,async(req,res)=>{
    const s=permittedSession(req);
    if(req.body.consent!==true)throw issue(400,'Please agree to audio transcription and AI review before joining.');
    if(s.status!=='scheduled')throw issue(409,'This session has ended.');
    const now=Date.now();if(now<s.starts_at)throw issue(409,'Your classroom opens at the scheduled start time.');if(now>s.starts_at+s.duration*60000)throw issue(409,'The scheduled session has ended.');
    if(!video)throw issue(503,'Live video is awaiting connection. No camera or microphone has been accessed.');
    if(!ai)throw issue(503,'AI monitoring must be connected before this classroom can open.');
    run('INSERT OR IGNORE INTO consents VALUES(?,?,?)',s.id,req.user.id,Date.now());
    const token=new AccessToken(env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET,{identity:req.user.id,name:req.user.name,ttl:'5m'});
    token.addGrant({roomJoin:true,room:`ss-${s.id}`,canPublish:true,canSubscribe:true,canPublishData:false});
    res.json({url:env.LIVEKIT_URL,token:await token.toJwt(),session:joinedSession(s)});
  });
  const audioBusy=new Set();
  app.post('/api/sessions/:id/audio',auth,express.raw({type:['audio/webm','audio/mp4'],limit:'3mb'}),async(req,res)=>{
    const s=permittedSession(req);
    if(s.teacher_id!==req.user.id)throw issue(403,'Only the teacher’s consented audio is analyzed.');
    if(!get('SELECT * FROM consents WHERE session_id=? AND user_id=?',s.id,req.user.id))throw issue(403,'Consent is required.');
    if(!ai||!video||s.status!=='scheduled')throw issue(409,'Monitoring is not available for this session.');
    if(Date.now()<s.starts_at||Date.now()>s.starts_at+s.duration*60000+90000)throw issue(409,'Audio is only accepted during the scheduled session.');
    if(!Buffer.isBuffer(req.body)||req.body.length<100)throw issue(400,'No audio received.');
    if(audioBusy.has(s.id))throw issue(429,'The previous audio segment is still processing.');
    const recentAudio=get('SELECT created_at FROM transcripts WHERE session_id=? ORDER BY created_at DESC LIMIT 1',s.id);
    if(recentAudio && Date.now()-recentAudio.created_at<25000)throw issue(429,'Please wait before sending another audio segment.');
    const participants=await new RoomServiceClient(env.LIVEKIT_URL,env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET).listParticipants(`ss-${s.id}`);
    if(!participants.some(p=>p.identity===req.user.id))throw issue(403,'Join the classroom before submitting audio.');
    audioBusy.add(s.id);
    try {const text=await transcribe(env,req.body,req.get('content-type'));run('INSERT INTO transcripts VALUES(?,?,?,?,?)',randomUUID(),s.id,req.user.id,codec.seal({text}),Date.now());
      const count=get('SELECT COUNT(*) AS n FROM transcripts WHERE session_id=?',s.id).n;
      if(count%4===0){const transcript=all('SELECT text FROM transcripts WHERE session_id=? ORDER BY created_at',s.id).map(t=>codec.open(t.text).text).join('\n');const report=await assess(env,s,transcript);run('UPDATE sessions SET report=? WHERE id=?',JSON.stringify({...report,stage:'live',updatedAt:Date.now()}),s.id);}
      res.json({ok:true});
    }finally{audioBusy.delete(s.id);}
  });

  function verifiedMinutes(s) {
    const events=all('SELECT * FROM attendance WHERE session_id=? ORDER BY at',s.id);
    const active=new Set();let last=s.starts_at,total=0;const end=s.starts_at+s.duration*60000;
    for(const e of events){const at=Math.min(end,Math.max(s.starts_at,e.at));if(at<last)continue;if(active.has(s.teacher_id)&&active.size>1)total+=at-last;last=at;if(e.event==='participant_joined')active.add(e.user_id);else active.delete(e.user_id);}
    // Only closed attendance intervals count; webhook loss must not mint teaching time.
    return Math.min(s.duration,Math.floor(total/60000));
  }
  const reviewBusy=new Set();
  async function finalize(id) {
    if(reviewBusy.has(id)||audioBusy.has(id))return;
    const s=get('SELECT * FROM sessions WHERE id=?',id);
    if(!s||s.status!=='scheduled'||Date.now()<s.starts_at+s.duration*60000+90000)return;
    reviewBusy.add(id);
    try {
      if(video){try{await new RoomServiceClient(env.LIVEKIT_URL,env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET).deleteRoom(`ss-${s.id}`);}catch{}}
      const rows=all('SELECT text FROM transcripts WHERE session_id=? ORDER BY created_at',s.id);
      const minutes=verifiedMinutes(s);
      if(!ai||!rows.length||minutes===0){run("UPDATE sessions SET status='review',report=? WHERE id=?",JSON.stringify({stage:'final',summary:'Not enough verified audio or attendance. Manual review is needed.',issues:[],coverage:[],needs_review:true}),id);finance.accrue(s,'held');return;}
      const report=await assess(env,s,rows.map(t=>codec.open(t.text).text).join('\n'),true);
      // AI flags refund the learner; they never automatically punish or ban the teacher.
      const refund=report.issues.some(x=>x.type!=='possible_fraud'&&x.confidence>=0.85);
      const incompleteEvidence=rows.length < Math.max(1,s.duration*0.6) || minutes<s.duration*0.8;
      const needsReview=report.needs_review||incompleteEvidence||report.issues.length>0;
      const status=refund?'refunded':needsReview?'review':'completed';
      transaction(()=>{
        if(refund)store.refundSession(id,'Teaching review identified a session issue');
        if(!s.teacher_awarded){run('UPDATE users SET earned=earned+? WHERE id=?',minutes,s.teacher_id);run('UPDATE sessions SET teacher_awarded=1 WHERE id=?',id);}
        run('UPDATE sessions SET status=?,report=? WHERE id=?',status,JSON.stringify({...report,stage:'final',verifiedMinutes:minutes,needs_review:needsReview,updatedAt:Date.now()}),id);
        finance.accrue(s,status==='completed'?'available':'held');
        log('system','session_review',{sessionId:id,status,verifiedMinutes:minutes});
      });
    }catch{run("UPDATE sessions SET status='review',report=? WHERE id=?",JSON.stringify({stage:'final',summary:'Automatic review could not finish. An administrator must review this session.',issues:[],coverage:[],needs_review:true}),id);finance.accrue(s,'held');}
    finally{reviewBusy.delete(id);}
  }
  app.post('/api/admin/sessions/:id/refund',auth,admin,(req,res)=>{
    const reason=validText(500).parse(req.body.reason);
    transaction(()=>{const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s)throw issue(404,'Session not found.');if(!['review','completed','refunded'].includes(s.status))throw issue(409,'Wait for the session to finish before reviewing it.');store.refundSession(s.id,reason);finance.hold(s.id);run("UPDATE sessions SET status='refunded' WHERE id=?",s.id);log(req.user.id,'manual_refund',{sessionId:s.id,reason});});res.json({ok:true});
  });
  app.post('/api/admin/sessions/:id/complete',auth,admin,(req,res)=>{
    const reason=validText(500).parse(req.body.reason);const s=get('SELECT * FROM sessions WHERE id=?',req.params.id);if(!s||s.status!=='review')throw issue(409,'This session is not pending review.');transaction(()=>{run("UPDATE sessions SET status='completed' WHERE id=?",s.id);finance.accrue(s,'available');});log(req.user.id,'manual_complete',{sessionId:s.id,reason});res.json({ok:true});
  });
  // Preview helpers never exist when NODE_ENV=production. Preview balances are not money.
  if(demo){
    app.post('/api/demo/enter',(req,res)=>{
      const role=z.enum(['student','teacher']).parse(req.body.role);let u=userForPhone(role==='student'?'+919000000001':'+919000000002');
      if(!u.role){run('UPDATE users SET role=?,name=?,degree=?,field=?,domain=? WHERE id=?',role,role==='student'?'Alex':'Aarav Mehta',role==='teacher'?'BTech':null,role==='teacher'?'Computer Science':null,'Coding lessons',u.id);if(role==='student')credit(u.id,'silver',60,`welcome:${u.id}`,'Welcome gift · 60 minutes of group learning');}
      seedDemo();u=get('SELECT * FROM users WHERE id=?',u.id);signIn(res,u);res.json({user:fullUser(u)});
    });
    app.post('/api/demo/orders/:id/complete',auth,(req,res)=>{
      transaction(()=>{const o=get('SELECT * FROM orders WHERE id=? AND user_id=?',req.params.id,req.user.id);if(!o)throw issue(404,'Order not found.');credit(o.user_id,o.kind,o.credits,`order:${o.id}`,'DEMO top-up · no money charged');run("UPDATE orders SET status='approved' WHERE id=?",o.id);});res.json({balance:balances(req.user.id)});
    });
  }
  function seedDemo(){
    if(get("SELECT id FROM sessions WHERE id='demo-python'"))return;
    const teacher=userForPhone('+919000000002');run("UPDATE users SET role='teacher',name='Aarav Mehta',degree='BTech',field='Computer Science' WHERE id=?",teacher.id);
    const teacher2=userForPhone('+919000000003');run("UPDATE users SET role='teacher',name='Meera Sharma',degree='MTech',field='Mathematics & Computing' WHERE id=?",teacher2.id);
    const teacher3=userForPhone('+919000000004');run("UPDATE users SET role='teacher',name='Rohan Kapoor',degree='BTech',field='Design Engineering' WHERE id=?",teacher3.id);
    const start=Date.now()+90*60000;
    const samples=[['demo-python',teacher.id,'Python, from zero to your first program','Coding lessons','Python','group',30,12,'A friendly first step into coding. Write your first program, understand variables, and make something that works.',['Variables and data types','Writing your first program','A hands-on mini challenge']],['demo-maths',teacher2.id,'Make calculus finally click','Class 12','Mathematics','group',60,8,'Explore derivatives visually, connect the ideas, and work through exam-style problems together.',['Understanding derivatives','The power rule','Practice problems']],['demo-design',teacher3.id,'Your first website, built together','Coding lessons','HTML & CSS','one',30,1,'A personal session to turn your idea into a webpage. Ask every question and learn at your own pace.',['HTML structure','CSS layout','Build a simple webpage']],['demo-dsa',teacher.id,'Think in algorithms','BTech','Data structures','group',45,10,'Build intuition for arrays and common problem-solving patterns with clear worked examples.',['Arrays','Two-pointer patterns','Time complexity']]];
    samples.forEach((s,i)=>run('INSERT INTO sessions(id,teacher_id,title,domain,subject,format,starts_at,duration,capacity,description,topics,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...s.slice(0,6),start+i*3600000,s[6],s[7],s[8],JSON.stringify(s[9]),Date.now()));
  }
  app.use(express.static(resolve('public'),{maxAge:production?'1h':0}));
  app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Not found'});res.sendFile(resolve('public/index.html'));});
  app.use((error,req,res,next)=>{if(error instanceof z.ZodError)return res.status(400).json({error:error.issues[0]?.message || 'Please check your entries.'});if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'This record already exists.'});if(!error.status)console.error('Request failed:',error.message);res.status(error.status || 500).json({error:error.status?error.message:'Something went wrong. Please try again.'});});
  let timer;
  function startJobs(){timer=setInterval(()=>{if(!demo)finance.reconcile().catch(()=>{});const cutoff=Date.now()-90000;for(const s of all("SELECT id FROM sessions WHERE status='scheduled' AND starts_at+duration*60000<? LIMIT 10",cutoff))finalize(s.id);run('DELETE FROM logins WHERE expires_at<?',Date.now());run('DELETE FROM challenges WHERE expires_at<?',Date.now()-3600000);run('DELETE FROM transcripts WHERE created_at<?',Date.now()-7*86400000);},30000);timer.unref();}
  return {app,store,finance,demo,finalize,startJobs,close(){clearInterval(timer);store.db.close();}};
}
