import { useEffect, useState } from 'react';
import type { TownAgent, TownMeeting } from '@shared/town';
import { CAST } from './townCast';
import puffUrl from '../assets/characters/smoke-puff.png';

/**
 * The people at a meeting, shown inside the Town Hall, all facing the owner (the empty chair at the near end of the table is theirs). Each hovers over a
 * chair, the way they do on the map. The person who is speaking, or has just spoken in a meeting run with AI help, has a bubble over their head with what
 * they are saying. Everything shown here is what is really happening in the meeting: nobody appears who is not at the table, and a bubble is only ever
 * the words of a real reply.
 */
export interface Said { id: string; text: string; at: number }

/** Where each person goes, in the order they were called: the head of the table first, then the chairs down each side, then spare places round the room.
 *  x and y are percent of the room picture (y is where they hover above the floor); w is how wide they are, wider the nearer to the viewer. */
const SEATS: ReadonlyArray<{ x: number; y: number; w: number }> = [
  { x: 49.8, y: 39, w: 4.2 }, { x: 32, y: 47, w: 4.6 }, { x: 67.6, y: 47, w: 4.6 }, { x: 27.5, y: 56, w: 5.2 }, { x: 71.8, y: 55, w: 5.2 },
  { x: 21, y: 70, w: 6 }, { x: 79, y: 69, w: 6 }, { x: 13, y: 60, w: 5.6 }, { x: 87, y: 61, w: 5.6 }, { x: 40, y: 90, w: 6.4 }, { x: 60, y: 90, w: 6.4 }, { x: 36, y: 36, w: 4 },
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
        const cast = a.director ? CAST[a.director] : undefined;
        const talking = speaking === a.id;
        const words = !talking && said?.id === a.id && now - said.at < BUBBLE_MS ? plain(said.text) : null;
        const frame = cast?.frame ?? { w: 40, h: 80 };
        return (
          <div key={a.id} className={`tw-hall-person${seat.x < 22 ? ' left' : seat.x > 78 ? ' right' : ''}${seat.y < 50 ? ' high' : ''}`} style={{ left: `${seat.x}%`, top: `${seat.y}%`, width: `${seat.w * (frame.w / 40)}%` }}>
            <span className="tw-puff-room tw-hall-puff" aria-hidden style={{ backgroundImage: `url(${puffUrl})` }} />
            {(talking || words) && (
              <div className="tw-bubble" role="status" aria-label={`${a.name} says`}>
                <strong>{a.name}</strong>
                {talking ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span> : <span>{words}</span>}
              </div>
            )}
            {cast
              ? <span className="tw-hall-figure tw-appear" role="img" aria-label={a.name} title={a.name} style={{ backgroundImage: `url(${cast.walk})`, aspectRatio: `${frame.w} / ${frame.h}` }} />
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
