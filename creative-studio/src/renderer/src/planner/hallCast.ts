import type { DirectorKey } from '@shared/town';
import gm from '../assets/hall/general-manager.png';
import creative from '../assets/hall/creative-director.png';
import quality from '../assets/hall/quality-director.png';
import research from '../assets/hall/research-director.png';
import production from '../assets/hall/production-director.png';
import ai from '../assets/hall/ai-director.png';
import media from '../assets/hall/media-manager.png';
import technical from '../assets/hall/technical-director.png';
import software from '../assets/hall/software-director.png';

/** Each director's front view from their full-size character sheet, waist up, looking at the viewer. Used for the people at a meeting in the Town Hall. */
export const HALL: Record<DirectorKey, string> = {
  'general-manager': gm, 'creative-director': creative, 'quality-director': quality, 'research-director': research, 'production-director': production,
  'ai-director': ai, 'media-manager': media, 'technical-director': technical, 'software-director': software,
};
