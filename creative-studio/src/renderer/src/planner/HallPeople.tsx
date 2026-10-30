import type { TownAgent, TownMeeting, TownState } from '@shared/town';
import { DIRECTORS } from '@shared/town';
import { HALL } from './hallCast';
import puffUrl from '../assets/characters/smoke-puff.png';

/**
 * The people at a meeting, shown inside the Town Hall, all facing the owner (the empty chair at the near end of the table is theirs). Each sits at a chair,
 * waist up, from their full-size character sheet. Everything shown is what is really happening in the meeting: nobody appears who is not at the table, a
 * ! over someone's head means they really have a reply waiting, and a bubble is only ever the words of a real reply the owner opened.
 */

/** Where each person sits, in the order they were called: the head of the table first, then the chairs down each side (left, right, left, right...), then the
 *  sofa and the head of the table. x is the middle of the seat and y the table edge they sit behind, as percent of the room picture; w is how wide they
 *  are, wider the nearer to the viewer. */
export const SEATS: ReadonlyArray<{ x: number; y: number; w: number }> = [
  { x: 50, y: 40, w: 7 }, { x: 33.5, y: 48, w: 7.5 }, { x: 66.5, y: 48, w: 7.5 }, { x: 28, y: 58.5, w: 8.5 }, { x: 72, y: 58.5, w: 8.5 }, { x: 22, y: 71, w: 10 }, { x: 78, y: 71, w: 10 },
  { x: 9.5, y: 47, w: 6.5 }, { x: 14.5, y: 46, w: 6.5 }, { x: 39, y: 36, w: 5.5 }, { x: 61, y: 36, w: 5.5 }, { x: 25, y: 34, w: 5 },
];

/** The words as a person would say them: no formatting marks, and short enough to read at a glance. */
export const plain = (t: string) => { const s = t.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); return s.length > 1600 ? `${s.slice(0, 1597).trimEnd()}…` : s; };

/** Bubbles are drawn in their own layer so the edge of the room never cuts them: each is a fixed share of the room's width, kept inside it, and its tail still points at the person. */
const BUBBLE_W = 36;
/** The small bubble with three dots over whoever is being asked: narrow, and drawn in front, so it hides as little as possible. */
const PILL_W = 15;
/** Room kept free at the bottom for the typing box, so a bubble that opens downwards stops above it and scrolls instead of covering it. */
const TYPING_BOX = 118;
/** A figure's height as a share of the room's height, from its width (the pictures are about 1.55 times taller than wide; the room is 1672 by 941). */
const figureH = (w: number) => w * 1.55 * (1672 / 941);
function bubbleSpot(seat: { x: number; y: number; w: number }, width: number) {
  const half = width / 2 + 1;
  const left = Math.min(100 - half, Math.max(half, seat.x));
  const tail = Math.min(88, Math.max(12, 50 + ((seat.x - left) / width) * 100));
  const top = seat.y - figureH(seat.w);
  // Above the head when there is room, otherwise just below the person.
  return top > 30 ? { left, tail, above: true, at: 100 - top + 0.5 } : { left, tail, above: false, at: seat.y + 1 };
}

export interface HallPeopleProps {
  people: TownAgent[];
  /** Who is being asked right now (three dots). */
  speaking: string | null;
  /** Who has something important to tell the owner (a ! over their head). At most one at a time. */
  waiting: ReadonlySet<string>;
  /** Why each ! is there, for the tooltip. */
  reasons?: ReadonlyMap<string, string>;
  /** Who the owner is talking with now (lit up), and what they last said (shown over their head until the owner speaks again). */
  current: string | null;
  open: { id: string; text: string; tasks?: string[] } | null;
  /** Tasks that person recommended (a box under their bubble offers to add each), and the ones already added. */
  onAddTask: (id: string, title: string) => void;
  added: ReadonlySet<string>;
  /** Someone pointed at: the ! one starts talking to the owner; anyone else becomes the one the owner talks with. */
  onPick: (id: string) => void;
  onCloseBubble: () => void;
  /** Words to show over someone without a reply, such as the greeting (not a reply, and not marked as one). */
  greeting?: { id: string; text: string } | null;
}

export function HallPeople({ people, speaking, waiting, reasons, current, open, onAddTask, added, onPick, onCloseBubble, greeting }: HallPeopleProps) {
  const seated = people.slice(0, SEATS.length);
  const shown = open ? { id: open.id, text: plain(open.text), closable: true, tasks: open.tasks ?? [] } : greeting ? { id: greeting.id, text: greeting.text, closable: false, tasks: [] as string[] } : null;
  return (
    <div className="tw-hall-people" aria-label="The people at the meeting">
      {seated.map((a, i) => {
        const seat = SEATS[i]!;
        const img = a.director ? HALL[a.director] : undefined;
        const alert = waiting.has(a.id);
        const talkingWith = current === a.id;
        return (
          <div key={a.id} className="tw-hall-person" style={{ left: `${seat.x}%`, top: `${seat.y}%`, width: `${seat.w}%` }}>
            <span className="tw-puff-room tw-hall-puff" aria-hidden style={{ backgroundImage: `url(${puffUrl})` }} />
            {alert && <span className="tw-hall-alert" aria-hidden>!</span>}
            <button type="button" className={`tw-hall-hit on${talkingWith ? ' current' : ''}`} onClick={() => onPick(a.id)}
              aria-label={alert ? `${a.name} could add something. Click to hear from them.` : talkingWith ? `${a.name}: you are talking with them` : `Talk to ${a.name}`} title={alert ? `${a.name} could add something${reasons?.get(a.id) ? ` (${reasons.get(a.id)})` : ''}. Click to hear from them.` : talkingWith ? `Talking with ${a.name}` : `Talk to ${a.name}`}>
              {img
                ? <img className="tw-hall-figure tw-appear" src={img} alt="" draggable={false} />
                : <span className="tw-avatar big tw-appear" style={{ background: a.look.accent }}>{a.name.slice(0, 1).toUpperCase()}</span>}
            </button>
            <small className="tw-hall-name">{a.name}</small>
          </div>
        );
      })}
      {seated.map((a, i) => {
        const thinking = speaking === a.id;
        const mine = !thinking && shown && shown.id === a.id ? shown : null;
        if (!thinking && !mine) return null;
        const b = bubbleSpot(SEATS[i]!, thinking ? PILL_W : BUBBLE_W);
        return (
          <div key={`say-${a.id}`} className={`tw-bubble${b.above ? '' : ' below'}${thinking ? ' pill' : mine?.closable ? ' open' : ''}`} role="status" aria-label={`${a.name} says`}
            onClick={thinking || !mine?.closable ? undefined : onCloseBubble}
            style={{ left: `${b.left}%`, width: `${thinking ? PILL_W : BUBBLE_W}%`, ...(b.above ? { bottom: `${b.at}%`, maxHeight: `calc(${100 - b.at}% - 8px)` } : { top: `${b.at}%`, maxHeight: `calc(${100 - b.at}% - ${TYPING_BOX}px)` }), ['--tail' as string]: `${b.tail}%` }}>
            <strong>{a.name}</strong>
            {thinking ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span> : <><span className="tw-bubble-text">{mine!.text}</span>
              {mine!.tasks.length > 0 && (
                <div className="tw-bubble-tasks" onClick={(e) => e.stopPropagation()}>
                  {mine!.tasks.map((t) => (
                    <div key={t} className="tw-bubble-task"><span>{t}</span>{added.has(t) ? <em>Added to your plan</em> : <button type="button" className="btn small primary" onClick={() => onAddTask(a.id, t)}>Add task</button>}</div>
                  ))}
                </div>
              )}
              {mine!.closable && <small className="tw-bubble-hint">Click to close</small>}</>}
          </div>
        );
      })}
    </div>
  );
}

/** Who sits at the table: the people called to a meeting, or, before one is called, the nine directors (the General Manager at the head). */
export function meetingPeople(town: Pick<TownState, 'agents'>, meeting: Pick<TownMeeting, 'participantIds'> | null): TownAgent[] {
  if (meeting) return meeting.participantIds.map((id) => town.agents.find((a) => a.id === id)).filter((a): a is TownAgent => !!a && !a.retired);
  return DIRECTORS.map((d) => town.agents.find((a) => a.director === d.key && !a.retired)).filter((a): a is TownAgent => !!a);
}
