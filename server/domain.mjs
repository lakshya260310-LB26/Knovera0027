export const DOMAINS = ['Coding lessons', ...Array.from({length: 12}, (_,i) => `Class ${i+1}`), 'BTech', 'MTech', 'Other lessons'];
export const DEGREES = ['12th pass', 'BTech', 'MTech', 'BSc', 'MBBS', 'MD / Physician', 'PhD'];
export const PACKS = {
  silver: [{credits:30, price:45, original:45}, {credits:90, price:125, original:135}, {credits:120, price:165, original:180}],
  gold: [{credits:30, price:150, original:150}, {credits:90, price:430, original:450}, {credits:120, price:570, original:600}]
};
export function priceFor(kind, credits) { return PACKS[kind]?.find(p => p.credits === credits); }
export function kindFor(format) { return format === 'group' ? 'silver' : 'gold'; }
export function issue(status, message) { return Object.assign(new Error(message), {status}); }
export function publicProfile(user) {
  if (!user) return null;
  return {id:user.id, role:user.role, name:user.name, degree:user.degree, field:user.field, domain:user.domain, earned:user.earned, createdAt:user.created_at};
}
