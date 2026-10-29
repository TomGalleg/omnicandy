import { useEffect, useState } from 'react';
import type { TownAgent, TownMeeting } from '@shared/town';
import { HALL } from './hallCast';
import puffUrl from '../assets/characters/smoke-puff.png';

/**
 * The people at a meeting, shown inside the Town Hall, all facing the owner (the empty chair at the near end of the table is theirs). Each hovers over a
 * chair, the way they do on the map. The person who is speaking, or has just spoken in a meeting run with AI help, has a bubble over their head with what
 * they are saying. Everything shown here is what is really happening in the meeting: nobody appears who is not at the table, and a bubble is only ever
 * the words of a real reply.
 */
export interface Said { id: string; text: string; at: number }

/** Where each person sits, in the order they were called: the head of the table first, then the chairs down each side (left, right, left, right...), then the
 *  sofa and the far side of the room. x is the middle of the seat and y the table edge they sit behind, as percent of the room picture; w is how wide they
 *  are, wider the nearer to the viewer. */
const SEATS: ReadonlyArray<{ x: number; y: number; w: number }> = [
  { x: 49.9, y: 41, w: 7 }, { x: 32, y: 53, w: 8 }, { x: 67.8, y: 53, w: 8 }, { x: 26.5, y: 63, w: 9 }, { x: 73, y: 63, w: 9 }, { x: 20, y: 77, w: 10.5 }, { x: 79.5, y: 77, w: 10.5 },
  { x: 9.5, y: 54, w: 7.5 }, { x: 15, y: 54, w: 7.5 }, { x: 88, y: 64, w: 8 }, { x: 93, y: 52, w: 7 }, { x: 40, y: 38, w: 6 },
];

/** The words as a person would say them: no formatting marks, and short enough to read at a glance. */
const plain = (t: string) => { const s = t.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); return s.length > 260 ? `${s.slice(0, 257).trimEnd()}…` : s; };

/** How long the words of the latest reply stay up before the bubble goes, in milliseconds. */
const BUBBLE_MS = 25_000;

export function HallPeople({ people, speaking, said }: { people: TownAgent[]; speaking: string | null; said: Said | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="tw-hall-people" aria-label="The people at the meeting">
      {people.slice(0, SEATS.length).map((a, i) => {
        const seat = SEATS[i]!;
        const img = a.director ? HALL[a.director] : undefined;
        const talking = speaking === a.id;
        const words = !talking && said?.id === a.id && now - said.at < BUBBLE_MS ? plain(said.text) : null;
        return (
          <div key={a.id} className={`tw-hall-person${seat.x < 22 ? ' left' : seat.x > 78 ? ' right' : ''}${seat.y < 56 ? ' high' : ''}`} style={{ left: `${seat.x}%`, top: `${seat.y}%`, width: `${seat.w}%` }}>
            <span className="tw-puff-room tw-hall-puff" aria-hidden style={{ backgroundImage: `url(${puffUrl})` }} />
            {(talking || words) && (
              <div className="tw-bubble" role="status" aria-label={`${a.name} says`}>
                <strong>{a.name}</strong>
                {talking ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span> : <span>{words}</span>}
              </div>
            )}
            {img
              ? <img className="tw-hall-figure tw-appear" src={img} alt={a.name} title={a.name} draggable={false} />
              : <span className="tw-avatar big tw-appear" style={{ background: a.look.accent }} title={a.name}>{a.name.slice(0, 1).toUpperCase()}</span>}
            <small className="tw-hall-name">{a.name}</small>
          </div>
        );
      })}
    </div>
  );
}

export const meetingPeople = (town: { agents: TownAgent[] }, meeting: Pick<TownMeeting, 'participantIds'>): TownAgent[] =>
  meeting.participantIds.map((id) => town.agents.find((a) => a.id === id)).filter((a): a is TownAgent => !!a && !a.retired);
