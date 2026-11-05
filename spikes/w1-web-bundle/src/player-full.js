// Player chunk with the full hls.js build + libpgs. Throwaway (W1).
import Hls from 'hls.js';
import { PgsRenderer } from 'libpgs';
import pgsWorker from 'libpgs/dist/libpgs.worker.js?url';

export function make(video, url) {
  const hls = new Hls({ enableWorker: true });
  hls.loadSource(url);
  hls.attachMedia(video);
  const pgs = new PgsRenderer({ video, workerUrl: pgsWorker, subUrl: '/x.sup' });
  video.requestVideoFrameCallback((_n, md) => pgs.renderAtTimestamp(md.mediaTime));
  return { hls, pgs };
}
