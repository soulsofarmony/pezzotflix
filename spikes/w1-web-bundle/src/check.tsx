// Type check under TypeScript 6 strict: hls.js light (typed through ambient.d.mts), libpgs, React 19. Throwaway (W1).
import Hls, { Events, type InitPTSFoundData } from 'hls.js/light';
import { PgsRenderer } from 'libpgs';

export function make(video: HTMLVideoElement, url: string): Hls {
  const hls = new Hls({ autoStartLoad: false });
  hls.on(Events.INIT_PTS_FOUND, (_e, d: InitPTSFoundData) => {
    console.log(d.initPTS / d.timescale);
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  const pgs = new PgsRenderer({ video, subUrl: '/x.sup' });
  pgs.timeOffset = 0;
  return hls;
}

export const El = (): React.JSX.Element => <p>x</p>;
