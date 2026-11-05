// Player chunk with the hls.js light build (ESM worker through workerPath) + libpgs. Throwaway (W1).
import Hls from 'hls.js/light';
import hlsWorker from 'hls.js/dist/hls.worker.js?url';
import { PgsRenderer } from 'libpgs';
import pgsWorker from 'libpgs/dist/libpgs.worker.js?url';

export function make(video, url) {
  const hls = new Hls({ enableWorker: true, workerPath: hlsWorker, autoStartLoad: false });
  hls.loadSource(url);
  hls.attachMedia(video);
  const pgs = new PgsRenderer({ video, workerUrl: pgsWorker, subUrl: '/x.sup' });
  video.requestVideoFrameCallback((_n, md) => pgs.renderAtTimestamp(md.mediaTime));
  return { hls, pgs };
}
