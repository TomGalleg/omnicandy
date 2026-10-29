/**
 * Who is inside their office right now. A director who walks up to their own door is hidden in a puff of smoke and stays in for a while; the same
 * director is also the one sitting at the desk when their office is opened. The town map and the office view are never on screen together, so the
 * time they come back out is kept here, and each picks up where the other left off. The key is the map spot of their door.
 */
const comesOutAt = new Map<string, number>();

/** How long a director stays in for, in milliseconds: between 7 and 13 seconds. */
export const stayInside = () => 7000 + Math.random() * 6000;

/** How long a director stays at their desk before getting up for a visit, in milliseconds: 20 to 60 seconds. */
export const restAtDesk = () => 20000 + Math.random() * 40000;

export const presence = (door: string): number | undefined => comesOutAt.get(door);
export const setPresence = (door: string, until: number) => { comesOutAt.set(door, until); };
export const clearPresence = (door: string) => { comesOutAt.delete(door); };
