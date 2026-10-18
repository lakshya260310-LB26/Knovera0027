import {OAuth2Client} from 'google-auth-library';
import {issue} from './domain.mjs';
export const googleVerifier=new OAuth2Client();
export async function verifyGoogleCredential(credential,audience) {
  try {
    const ticket=await googleVerifier.verifyIdToken({idToken:credential,audience});
    const payload=ticket.getPayload();
    if(!payload||typeof payload.sub!=='string'||!payload.sub||payload.email_verified!==true||typeof payload.email!=='string')throw new Error('Unverified account');
    return payload;
  } catch {throw issue(401,'Google sign-in could not be verified. Please try again.');}
}
