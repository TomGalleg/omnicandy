// What the owner means by a short typed reply, with no AI: a plain "yes" to something a director offered, and "let's build this". Deliberately strict: a reply with
// anything extra in it ("yes but make it blue", a question) is not a plain yes and goes to the director as an ordinary message. A misread costs the owner a task
// they did not want, so when unsure it is not a yes.
const words = (t: string): string[] => t.toLowerCase().replace(/[’`]/g, '\'').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'please', 'definitely', 'absolutely', 'correct', 'great', 'good', 'fine', 'perfect', 'sounds', 'works', 'that', 'it', 'do', 'go', 'ahead', 'for', 'of', 'course', 'lets', 'let\'s', 'thanks', 'thank', 'you', 'yes', 'and', 'now', 'on', 'then', 'with', 'the', 'plan', 'sounds', 'like', 'a']);
const MUST = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'definitely', 'absolutely', 'sounds', 'do', 'go', 'lets', 'let\'s', 'please', 'perfect', 'great', 'fine', 'works']);
const STOP = new Set(['no', 'not', 'dont', 'don\'t', 'but', 'except', 'instead', 'wait', 'stop', 'never', 'nope', 'maybe', 'later', 'however', 'only', 'also', 'change']);

/** True for a short, plain yes: "yes", "yeah do it", "sure, go ahead", "sounds good". False for anything with a condition, a question or a change. */
export function isYes(text: string): boolean {
  if (text.includes('?')) return false;
  const w = words(text);
  if (w.length === 0 || w.length > 7) return false;
  if (w.some((x) => STOP.has(x))) return false;
  return w.every((x) => YES.has(x)) && w.some((x) => MUST.has(x));
}

const NO = new Set(['no', 'nope', 'nah', 'skip', 'never', 'mind', 'not', 'now', 'thanks', 'thank', 'you', 'later', 'dont', 'don\'t', 'leave', 'it', 'that']);
/** True for a short, plain no to an offer. The offer is then dropped (nothing is added). */
export function isNo(text: string): boolean {
  const w = words(text);
  if (w.length === 0 || w.length > 5 || text.includes('?')) return false;
  return w.every((x) => NO.has(x)) && w.some((x) => ['no', 'nope', 'nah', 'skip', 'never', 'later'].includes(x) || (w.includes('not') && w.includes('now')));
}

/** True when the owner asks, in a few words, for a specialist per program ("hire a specialist for each", "hire specialists"). */
export function wantsHire(text: string): boolean {
  if (text.includes('?')) return false;
  const w = words(text);
  if (w.length === 0 || w.length > 12) return false;
  const t = w.join(' ');
  return /\b(hire|get|add|bring in)\b.*\bspecialists?\b/.test(t);
}

const BUILD = [
  /^(lets|let's|ok|okay|alright|right|now|so|please)?\s*(lets|let's)?\s*(build|start|begin|make)\s+(this|it|everything|the project|the whole thing)$/,
  /^(lets|let's|ok|okay|alright|now|please)?\s*(start|begin)\s+(building|working|the build)$/,
  /^(lets|let's|ok|okay|alright|now|please)?\s*get\s+(started|going|building)$/,
  /^(lets|let's)\s+(go|do it|do this|begin|start)$/,
  /^(go ahead and|time to)\s+(build|start|begin)(\s+(this|it|everything))?$/,
  /^(build|start)\s+(it|this)\s+(now|please)$/,
];
/** True when the owner says, in a few words, to get the project built ("let's build this", "start building"). */
export function wantsBuild(text: string): boolean {
  if (text.includes('?')) return false;
  const w = words(text);
  if (w.length === 0 || w.length > 8) return false;
  const t = w.join(' ');
  return BUILD.some((re) => re.test(t));
}
