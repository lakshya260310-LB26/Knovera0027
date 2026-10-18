import {generateKeyPairSync,sign} from 'node:crypto';
import {googleVerifier} from '../../server/google-auth.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
export function mockGoogleKeys(){const original=googleVerifier.getFederatedSignonCertsAsync;googleVerifier.getFederatedSignonCertsAsync=async()=>({certs:{test:publicKey.export({type:'spki',format:'pem'})}});return ()=>{googleVerifier.getFederatedSignonCertsAsync=original;};}
export function googleToken(nonce,overrides={}){const now=Math.floor(Date.now()/1000);const body={iss:'https://accounts.google.com',aud:'test.apps.googleusercontent.com',sub:'test-google-user',email:'learner@gmail.com',email_verified:true,iat:now,exp:now+3600,nonce,...overrides};const data=[{alg:'RS256',kid:'test'},body].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');}
