import type { DirectorKey } from '@shared/town';
import managerWalk from '../assets/characters/general-manager-walk.png';
import managerSeated from '../assets/characters/general-manager-seated.png';
import creativeWalk from '../assets/characters/creative-director-walk.png';
import creativeSeated from '../assets/characters/creative-director-seated.png';
import techWalk from '../assets/characters/technical-director-walk.png';
import techSeated from '../assets/characters/technical-director-seated.png';
import mediaWalk from '../assets/characters/media-manager-walk.png';
import mediaSeated from '../assets/characters/media-manager-seated.png';
import aiWalk from '../assets/characters/ai-director-walk.png';
import aiSeated from '../assets/characters/ai-director-seated.png';
import productionWalk from '../assets/characters/production-director-walk.png';
import productionSeated from '../assets/characters/production-director-seated.png';
import softwareWalk from '../assets/characters/software-director-walk.png';
import softwareSeated from '../assets/characters/software-director-seated.png';
import researchWalk from '../assets/characters/research-director-walk.png';
import researchSeated from '../assets/characters/research-director-seated.png';
import qualityWalk from '../assets/characters/quality-director-walk.png';
import qualitySeated from '../assets/characters/quality-director-seated.png';

/**
 * The directors who have been drawn so far. Each has a strip of gliding and idle frames for the map and a seated picture for the desk; a director
 * without an entry simply has no figure yet. `start` is the map spot the figure begins from, and `seat` places the seated picture in the office
 * (percent of the room picture) with `desk`, the shape of the desk and laptop drawn back over the figure so it sits behind them.
 */
export interface CastMember {
  walk: string; seated: string; start: string;
  /** Which way round the sheet lists its eight facings: `west` starts south, south-west, west...; `east` starts south, south-east, east... */
  order?: 'west' | 'east';
  /** Frame shape for sheets drawn wider or taller than the usual 40 by 80, and how fast the figure steps (1 is normal). */
  frame?: { w: number; h: number }; rate?: number;
  seat: { left: number; top: number; width: number };
  desk: string;
}
const GM_DESK = 'polygon(41.9% 41.9%, 47.2% 41.9%, 47.6% 38.3%, 52.3% 38.3%, 52.6% 41.9%, 58.6% 41.9%, 58.6% 53.7%, 41.9% 53.7%)';
const CD_DESK = 'polygon(39% 41.4%, 47.4% 41.4%, 47.6% 38.3%, 52.4% 38.3%, 52.6% 41.4%, 61.2% 41.4%, 61.2% 52.8%, 39% 52.8%)';
const QD_DESK = 'polygon(40% 40.3%, 47.9% 40.3%, 48.1% 38.9%, 52.1% 38.9%, 52.3% 40.3%, 60.4% 40.3%, 60.4% 49.5%, 40% 49.5%)';
const TD_DESK = 'polygon(39.8% 41.2%, 47.9% 41.2%, 48.1% 39.4%, 52.2% 39.4%, 52.4% 41.2%, 60.7% 41.2%, 60.7% 50.5%, 39.8% 50.5%)';
const MM_DESK = 'polygon(39.6% 43.6%, 47.4% 43.6%, 47.6% 41.6%, 52.4% 41.6%, 52.6% 43.6%, 60.4% 43.6%, 60.4% 55%, 39.6% 55%)';
const AD_DESK = 'polygon(39.8% 42.4%, 47.4% 42.4%, 47.6% 40.3%, 52.4% 40.3%, 52.6% 42.4%, 60.8% 42.4%, 60.8% 52.5%, 39.8% 52.5%)';
const PD_DESK = 'polygon(38.8% 42.2%, 47.6% 42.2%, 47.8% 39.1%, 52.4% 39.1%, 52.6% 42.2%, 61.3% 42.2%, 61.3% 52%, 38.8% 52%)';
const SD_DESK = 'polygon(39% 41.2%, 47.7% 41.2%, 47.9% 39%, 52.3% 39%, 52.5% 41.2%, 60.9% 41.2%, 60.9% 52%, 39% 52%)';
const RD_DESK = 'polygon(40.6% 38.5%, 47.6% 38.5%, 47.8% 36.5%, 52.2% 36.5%, 52.4% 38.5%, 59.3% 38.5%, 59.3% 50.2%, 40.6% 50.2%)';
export const CAST: Partial<Record<DirectorKey, CastMember>> = {
  'general-manager': { walk: managerWalk, seated: managerSeated, start: 'gm', seat: { left: 49.9, top: 30, width: 4.6 }, desk: GM_DESK },
  'creative-director': { walk: creativeWalk, seated: creativeSeated, start: 'creative', seat: { left: 50, top: 30, width: 4.6 }, desk: CD_DESK },
  'quality-director': { walk: qualityWalk, seated: qualitySeated, start: 'quality', seat: { left: 50, top: 30.5, width: 4.6 }, desk: QD_DESK },
  'technical-director': { walk: techWalk, seated: techSeated, start: 'tech', order: 'east', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 50, top: 31, width: 4.9 }, desk: TD_DESK },
  'media-manager': { walk: mediaWalk, seated: mediaSeated, start: 'media', order: 'east', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 49.6, top: 33.5, width: 4.9 }, desk: MM_DESK },
  'ai-director': { walk: aiWalk, seated: aiSeated, start: 'ai', order: 'east', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 50, top: 31.8, width: 4.9 }, desk: AD_DESK },
  'production-director': { walk: productionWalk, seated: productionSeated, start: 'prod', order: 'east', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 50, top: 31, width: 4.9 }, desk: PD_DESK },
  'software-director': { walk: softwareWalk, seated: softwareSeated, start: 'software', order: 'east', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 50, top: 31, width: 4.9 }, desk: SD_DESK },
  'research-director': { walk: researchWalk, seated: researchSeated, start: 'research', frame: { w: 54, h: 86 }, rate: 0.8, seat: { left: 50, top: 29.5, width: 4.9 }, desk: RD_DESK },
};
