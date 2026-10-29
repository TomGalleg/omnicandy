import { useEffect, useRef } from 'react';
import type { CastMember } from './townCast';
import type { ActivityState } from '@shared/townActivity';
import { CHAT, chooseTrip, WORK_VISIT_MS, type Intent } from '@shared/townIntent';
import puffUrl from '../assets/characters/smoke-puff.png';
import { clearPresence, presence, restAtDesk, setPresence, stayInside } from './townPresence';

/** The puff of smoke that hides a director as they go in and shows them as they come out: 22 frames, and the director is swapped at the fullest one. */
const PUFF_FRAMES = 22;
const PUFF_SECONDS = 1.1;
const PUFF_PEAK = 0.5;

/**
 * Directors who have been drawn glide round the town. Each follows the paved paths on the map from one office to the next and stops for a few seconds at each
 * door. This is a picture of a person walking, not a sign that work is happening: it says nothing about what the team is doing.
 * Positions are percentages of the map picture, so it scales with the map.
 */
const NODES: Record<string, readonly [number, number]> = {
  steps: [50, 46], hl: [36, 47], hr: [64, 47], pR: [74, 45],
  rNW: [31, 52], rW: [30, 61], rSW: [36, 70], rS: [50, 73], rSE: [64, 70], rE: [70, 61], rNE: [69, 52],
  gm: [15, 56], creative: [22, 36], ai: [37, 26], software: [64, 26], prod: [82, 34], tech: [86, 57], media: [79, 84], research: [50, 90], quality: [19, 84],
  pQ: [33, 82], pB: [41, 93],
};
const EDGES: ReadonlyArray<readonly [string, string]> = [
  ['steps', 'hl'], ['steps', 'hr'], ['hl', 'rNW'], ['hr', 'rNE'], ['rNW', 'rW'], ['rW', 'rSW'], ['rSW', 'rS'], ['rS', 'rSE'], ['rSE', 'rE'], ['rE', 'rNE'],
  ['gm', 'rW'], ['creative', 'hl'], ['ai', 'creative'], ['software', 'prod'], ['prod', 'pR'], ['pR', 'hr'], ['tech', 'rE'], ['media', 'rSE'],
  ['rSW', 'pQ'], ['pQ', 'quality'], ['pQ', 'pB'], ['pB', 'research'],
];
const OFFICES = new Set(['gm', 'creative', 'ai', 'software', 'prod', 'tech', 'media', 'research', 'quality']);
const NEXT: Record<string, string[]> = {};
for (const [a, b] of EDGES) { (NEXT[a] ??= []).push(b); (NEXT[b] ??= []).push(a); }
/** The corners to walk through to get from one place to another along the paths, not counting where you start. */
const pathBetween = (from: string, goal: string): string[] => {
  const before = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift()!;
    if (here === goal) break;
    for (const n of NEXT[here] ?? []) if (!before.has(n)) { before.set(n, here); queue.push(n); }
  }
  if (!before.has(goal)) return [];
  const out: string[] = [];
  for (let c = goal; c !== from; c = before.get(c)!) out.unshift(c);
  return out;
};

/** The map picture is 16:9, so a step sideways covers more of the picture's width than the same step up covers of its height. */
const WIDE = 16 / 9;
const SPEED = 10; // per second, in percent of the picture's height
const TURN = 3.4; // radians per second: a quarter turn takes about half a second and passes through the frames in between
const ARRIVE = 3.2; // close enough to a corner to start for the next one, which rounds the corner instead of pivoting on it
const TAU = Math.PI * 2;
const wrap = (a: number) => { let x = a % TAU; if (x > Math.PI) x -= TAU; if (x < -Math.PI) x += TAU; return x; };

/**
 * The strip has 8 facings of 4 gliding frames each, then 8 facings of 4 idle frames, in the order south, south-west, west, north-west, north,
 * north-east, east, south-east. `heading` is 0 facing the viewer and grows towards the right of the map (east), so the facings count round
 * the other way from the strip.
 */
const FRAMES = 4;
const IDLE_AT = 32;
const frameFor = (heading: number, step: number, idle: boolean, east: boolean) => {
  const compass = Math.round((((heading % TAU) + TAU) % TAU) / TAU * 8) % 8; // south, south-east, east, north-east, north, ...
  const facing = east ? compass : (8 - compass) % 8; // sheets that list the west side first run round the other way
  return (idle ? IDLE_AT : 0) + facing * FRAMES + (step % FRAMES);
};
const STEPS_PER_SECOND = 6;
const BREATHS_PER_SECOND = 2.5;

/** What is really going on with this director (from the plan), shown as a small badge over their figure, or over their door while they are inside. */
export interface WalkerBadge { state: ActivityState; label: string }

/** `intent` is why this director may leave their desk (from the plan); `targetDoor` is the door of the office a work visit is for. */
export function TownWalker({ who, name, onOpen, badge, intent, targetDoor }: { who: CastMember; name: string; onOpen: () => void; badge?: WalkerBadge; intent?: Intent; targetDoor?: string }) {
  const reason = useRef({ intent: intent ?? CHAT, targetDoor });
  reason.current = { intent: intent ?? CHAT, targetDoor };
  const el = useRef<HTMLButtonElement>(null);
  const badgeEl = useRef<HTMLButtonElement>(null);
  const puffEl = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    const puff = puffEl.current;
    const flag = badgeEl.current;
    if (!node || !puff || !flag) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let at = who.start in NODES ? who.start : 'steps';
    let to = '';
    let route: string[] = []; // the corners still to walk through
    let trip: 'visit' | 'home' = 'visit';
    let pos: [number, number] = [...NODES[at]!];
    let heading = 0; // 0 faces the viewer
    let wait = still ? Infinity : 1.2;
    let last = performance.now();
    let raf = 0;
    let stride = 0;
    let breath = 0;
    const draw = (walking: boolean) => {
      node.style.left = `${pos[0]}%`; node.style.top = `${pos[1]}%`;
      flag.style.left = `${pos[0]}%`; flag.style.top = `${pos[1]}%`;
      node.style.backgroundPositionX = `${(frameFor(heading, Math.floor(walking ? stride : breath), !walking, who.order === 'east') / 63) * 100}%`;
      node.dataset.walking = walking ? '1' : '0';
    };
    // Going in and out of their own office: out (on the map), in (puff, then gone), inside (hidden), exit (puff, then back).
    const door = who.start;
    let phase: 'out' | 'in' | 'inside' | 'exit' = 'out';
    let phaseT = 0;
    let comeOut = 0;
    let visiting = false; // inside another director's office, not their own
    let workVisit = false; // ... for work (a reason from the plan), not a chat
    let chosen: ReturnType<typeof chooseTrip> | null = null;
    const neighbours = () => [...OFFICES].filter((n) => n !== door && n in NODES);
    const kept = still ? undefined : presence(door);
    if (kept !== undefined && door in NODES) {
      pos = [...NODES[door]!]; at = door;
      phase = kept > Date.now() ? 'inside' : 'exit';
      comeOut = kept; node.style.visibility = 'hidden';
      if (phase === 'exit') clearPresence(door);
    } else if (!still && door in NODES) {
      // Everyone starts at their desk, inside their own office, and gets up for a visit after a while.
      phase = 'inside'; comeOut = Date.now() + 2000 + Math.random() * 28000; setPresence(door, comeOut);
      node.style.visibility = 'hidden'; pos = [...NODES[door]!]; at = door;
    }
    /** Get up: go where the plan (or an idle moment) says, or, if already visiting, go back to the desk. */
    const planTrip = () => {
      route = [];
      if (visiting) { visiting = false; workVisit = false; trip = 'home'; route = pathBetween(at, door); return; }
      const t = chosen ?? chooseTrip(reason.current.intent, neighbours(), reason.current.targetDoor, Math.random);
      chosen = null;
      if (!t.go) { trip = 'home'; phase = 'in'; phaseT = 0; return; } // nothing to go for: straight back to the desk
      trip = 'visit'; workVisit = t.purpose === 'work'; route = pathBetween(at, t.to);
    };
    const showPuff = () => {
      const f = Math.min(PUFF_FRAMES - 1, Math.floor((phaseT / PUFF_SECONDS) * PUFF_FRAMES));
      puff.style.display = 'block'; puff.style.left = `${pos[0]}%`; puff.style.top = `${pos[1]}%`;
      puff.style.backgroundPositionX = `${(f / (PUFF_FRAMES - 1)) * 100}%`;
    };
    draw(false);
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (phase !== 'out') {
        if (phase === 'inside') {
          const nowMs = Date.now();
          // A work visit ends when the work does; a director at their desk with a real reason to go does not wait out the rest.
          if (visiting && workVisit && reason.current.intent.kind !== 'work-visit') comeOut = Math.min(comeOut, nowMs);
          if (!visiting && reason.current.intent.kind === 'work-visit' && comeOut - nowMs > 2500) { comeOut = nowMs + 2000; setPresence(door, comeOut); }
          if (nowMs >= comeOut) {
            if (visiting) { phase = 'exit'; phaseT = 0; }
            else {
              const t = chooseTrip(reason.current.intent, neighbours(), reason.current.targetDoor, Math.random);
              if (t.go) { chosen = t; phase = 'exit'; phaseT = 0; clearPresence(door); }
              else { comeOut = nowMs + 5000; setPresence(door, comeOut); } // real work or a result waiting keeps them at the desk
            }
          }
        } else {
          phaseT += dt; heading += Math.max(-TURN * dt, Math.min(TURN * dt, wrap(0 - heading))); breath += dt * BREATHS_PER_SECOND; draw(false); showPuff();
          const peak = phaseT >= PUFF_PEAK * PUFF_SECONDS, done = phaseT >= PUFF_SECONDS;
          if (phase === 'in') {
            if (peak) node.style.visibility = 'hidden';
            if (done) { phase = 'inside'; puff.style.display = 'none'; comeOut = Date.now() + (visiting ? (workVisit ? WORK_VISIT_MS : stayInside()) : restAtDesk()); if (!visiting) setPresence(door, comeOut); }
          } else {
            if (peak) node.style.visibility = 'visible';
            if (done) { phase = 'out'; puff.style.display = 'none'; wait = 0.6; planTrip(); }
          }
        }
        raf = requestAnimationFrame(tick); return;
      }
      if (wait > 0) {
        // Standing: turn to face the viewer, through every frame on the way.
        const d = wrap(0 - heading);
        heading += Math.max(-TURN * dt, Math.min(TURN * dt, d));
        wait -= dt; breath += dt * BREATHS_PER_SECOND; draw(false);
      } else {
        if (!to) to = route.shift() ?? '';
        const goal = NODES[to];
        if (!goal) { wait = 2; raf = requestAnimationFrame(tick); return; }
        const gx = (goal[0] - pos[0]) * WIDE, gy = goal[1] - pos[1];
        const d = Math.hypot(gx, gy);
        if (d < ARRIVE) {
          at = to; to = '';
          if (!route.length && !still) { visiting = trip === 'visit'; phase = 'in'; phaseT = 0; pos = [...NODES[at]!]; } // arrived: in through the door
          draw(false);
        } else {
          // Steer towards the next corner a little at a time; slow right down while still swinging round.
          const diff = wrap(Math.atan2(gx, gy) - heading);
          heading += Math.max(-TURN * dt, Math.min(TURN * dt, diff));
          const step = SPEED * dt * (Math.abs(diff) > 0.9 ? 0.3 : 1);
          pos = [pos[0] + (Math.sin(heading) * step) / WIDE, pos[1] + Math.cos(heading) * step];
          stride += dt * STEPS_PER_SECOND * (who.rate ?? 1) * (Math.abs(diff) > 0.9 ? 0.5 : 1);
          draw(true);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [who.start, who.order, who.rate]);
  return <>
    <button ref={badgeEl} type="button" className={`tw-badge ${badge?.state ?? ''}`} hidden={!badge} title={badge?.label} aria-label={badge ? `${name}: ${badge.label}. Open the office.` : undefined} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{badge?.state === 'working' ? '⚙' : '!'}</button>
    <span ref={puffEl} className="tw-puff" aria-hidden style={{ backgroundImage: `url(${puffUrl})` }} />
    <button ref={el} className="tw-walker" style={{ backgroundImage: `url(${who.walk})`, ...(who.frame ? { width: `${4.1 * (who.frame.w / 40)}%`, aspectRatio: `${who.frame.w} / ${who.frame.h}` } : {}) }} onClick={(e) => { e.stopPropagation(); onOpen(); }} aria-label={`${name}, gliding round the town. Open the office.`} title={name} />
  </>;
}
