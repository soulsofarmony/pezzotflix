# Decoder della TV: `media_codecs.xml` del vendor e `MediaCodecList(ALL_CODECS)`

Riassunto generato da `spikes/s5-tv-client/evidence.py` (non è il file del vendor). Fonti: `adb shell cat /vendor/etc/media_codecs.xml` e `media_codecs_c2.xml` (decoder dichiarati) e `MediaCodecList(ALL_CODECS)` letto dall'app sonda (`raw-caps.json`, decoder che un'app può usare). Varianti `.secure` omesse.

| File | Componente | MIME dichiarati | Limiti | Funzioni | In `MediaCodecList(ALL_CODECS)` |
|---|---|---|---|---|---|
| mc.xml | `OMX.MS.M4V.Decoder` | `video/mp4v-es` | size 1920x1088 | tunneled-playback | sì: `video/mp4v-es` |
| mc.xml | `OMX.MS.H263.Decoder` | `video/3gpp` | - | tunneled-playback | sì: `video/3gpp` |
| mc.xml | `OMX.MS.AVC.Decoder` | `video/avc` | size 4096x2304 | tunneled-playback, low-latency | sì: `video/avc` |
| mc.xml | `OMX.MS.HEVC.Decoder` | `video/hevc` | size 4096x2176 | tunneled-playback, low-latency | sì: `video/hevc` |
| mc.xml | `OMX.MS.HEVCDV.Decoder` | `video/hevcdv` | size 4096x2176 | tunneled-playback | **no** |
| mc.xml | `OMX.MS.DOLBY_VISION.DVHE.DTR.Decoder` | `video/dolby-vision` | size 4096x2176 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.DOLBY_VISION.DVHE.STN.Decoder` | `video/dolby-vision` | size 4096x2176 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.DOLBY_VISION.DVHE.ST.Decoder` | `video/dolby-vision` | size 4096x2176 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.DOLBY_VISION.Decoder` | `video/dolby-vision` | size 4096x2176 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.DOLBY_VISION.DVAV.SE.Decoder` | `video/dolby-vision` | size 4096x2176 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.AVC.DOLBY_VISION.Decoder` | `video/dolby-vision` | size 4096x2304 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.MPEG2.Decoder` | `video/mpeg2` | - | tunneled-playback | sì: `video/mpeg2` |
| mc.xml | `OMX.MS.VP8.Decoder` | `video/x-vnd.on2.vp8` | size 1920x1088 | tunneled-playback | sì: `video/x-vnd.on2.vp8` |
| mc.xml | `OMX.MS.VP9.Decoder` | `video/x-vnd.on2.vp9` | size 4096x2176 | tunneled-playback, low-latency | sì: `video/x-vnd.on2.vp9` |
| mc.xml | `OMX.MS.DOLBY_VISION.DVAV1.Decoder` | `video/dolby-vision` | size 4096x2304 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.AV1.DOLBY_VISION.Decoder` | `video/dolby-vision` | size 4096x2304 | tunneled-playback | sì: `video/dolby-vision` |
| mc.xml | `OMX.MS.AV1.Decoder` | `video/av01` | size 4096x2304 | tunneled-playback, low-latency | sì: `video/av01` |
| mc.xml | `OMX.MS.AVS2.Decoder` | `video/avs2` | size 4096x2160 | tunneled-playback | **no** |
| mc.xml | `OMX.MS.FLV.Decoder` | `video/flv` | - | tunneled-playback | sì: `video/flv` |
| mc.xml | `OMX.MS.VC1.Decoder` | `video/VC1` | - | tunneled-playback | sì (MIME diversi) |
| mc.xml | `OMX.MS.WMV3.Decoder` | `video/x-ms-wmv` | - | tunneled-playback | sì: `video/x-ms-wmv` |
| mc.xml | `OMX.MS.MJPG.Decoder` | `video/x-motion-jpeg` | - | tunneled-playback | sì: `video/x-motion-jpeg` |
| mc.xml | `OMX.MS.AVS.Decoder` | `video/avs` | - | tunneled-playback | **no** |
| mc.xml | `OMX.MS.RV.Decoder` | `video/vnd.rn-realvideo` | - | tunneled-playback | **no** |
| mc.xml | `OMX.MS.MP1.Decoder` | `audio/mpeg-L1` | - | - | sì (MIME diversi) |
| mc.xml | `OMX.MS.MP2.Decoder` | `audio/mpeg-L2` | - | - | sì (MIME diversi) |
| mc.xml | `OMX.MS.AAC.Decoder` | `audio/mp4a-latm-hw` | - | - | sì: `audio/mp4a-latm-hw` |
| mc.xml | `OMX.MS.ADPCM.Decoder` | `audio/adpcm`, `audio/x-adpcm-ms`, `audio/x-adpcm-ima` | - | - | sì: `audio/x-adpcm-ms`, `audio/x-adpcm-ima` |
| mc.xml | `OMX.MS.LPCM.Decoder` | `audio/lpcm` | - | - | **no** |
| mc.xml | `OMX.MS.RA.Decoder` | `audio/vnd.rn-realaudio` | - | - | **no** |
| mc.xml | `OMX.MS.WMA.Decoder` | `audio/x-ms-wma`, `audio/x-ms-wmapro` | - | - | **no** |
| mc.xml | `OMX.MS.AC3.Decoder` | `audio/ac3` | channel-count 6 | - | sì: `audio/ac3` |
| mc.xml | `OMX.MS.EAC3.Decoder` | `audio/eac3`, `audio/ac3p` | channel-count 6 | - | sì: `audio/eac3` |
| mc.xml | `OMX.MS.DTS.Decoder` | `audio/dts`, `audio/dts-hd`, `audio/dts-lbr`, `audio/vnd.dts`, `audio/vnd.dts.hd`, `audio/vnd.dts.hd;profile=lbr`, `audio/vnd.dts.uhd;profile=p2` | channel-count 6 | - | **no** |
| mc.xml | `OMX.MS.DRA.Decoder` | `audio/dra` | - | - | **no** |
| mc_c2.xml | `c2.android.mp3.decoder` | `audio/mpeg` | channel-count 2, bitrate 8000-320000 | - | sì: `audio/mpeg` |
| mc_c2.xml | `c2.android.amrnb.decoder` | `audio/3gpp` | channel-count 1, bitrate 4750-12200 | - | sì: `audio/3gpp` |
| mc_c2.xml | `c2.android.amrwb.decoder` | `audio/amr-wb` | channel-count 1, bitrate 6600-23850 | - | sì: `audio/amr-wb` |
| mc_c2.xml | `c2.android.aac.decoder` | `audio/mp4a-latm` | channel-count 8, bitrate 8000-960000 | - | sì: `audio/mp4a-latm` |
| mc_c2.xml | `c2.android.g711.alaw.decoder` | `audio/g711-alaw` | channel-count 1, bitrate 64000 | - | sì: `audio/g711-alaw` |
| mc_c2.xml | `c2.android.g711.mlaw.decoder` | `audio/g711-mlaw` | channel-count 1, bitrate 64000 | - | sì: `audio/g711-mlaw` |
| mc_c2.xml | `c2.android.vorbis.decoder` | `audio/vorbis` | channel-count 8, bitrate 32000-500000 | - | sì: `audio/vorbis` |
| mc_c2.xml | `c2.android.opus.decoder` | `audio/opus` | channel-count 8, bitrate 6000-510000 | - | sì: `audio/opus` |
| mc_c2.xml | `c2.android.raw.decoder` | `audio/raw` | channel-count 8, bitrate 1-10000000 | - | sì: `audio/raw` |
| mc_c2.xml | `c2.android.flac.decoder` | `audio/flac` | channel-count 8, bitrate 1-21000000 | - | sì: `audio/flac` |
| mc_c2.xml | `c2.android.gsm.decoder` | `audio/gsm` | channel-count 1, bitrate 13000 | - | **no** |
| mc_c2.xml | `c2.android.mpeg4.decoder` | `video/mp4v-es` | size 352x288, bitrate 1-384000 | - | sì: `video/mp4v-es` |
| mc_c2.xml | `c2.android.h263.decoder` | `video/3gpp` | size 352x288, bitrate 1-384000 | - | sì: `video/3gpp` |
| mc_c2.xml | `c2.android.avc.decoder` | `video/avc` | size 4080x4080, bitrate 1-48000000 | - | sì: `video/avc` |
| mc_c2.xml | `c2.android.hevc.decoder` | `video/hevc` | size 4096x4096, bitrate 1-10000000 | - | sì: `video/hevc` |
| mc_c2.xml | `c2.android.vp8.decoder` | `video/x-vnd.on2.vp8` | size 2048x2048, bitrate 1-40000000 | - | sì: `video/x-vnd.on2.vp8` |
| mc_c2.xml | `c2.android.vp9.decoder` | `video/x-vnd.on2.vp9` | size 2048x2048, bitrate 1-40000000 | - | sì: `video/x-vnd.on2.vp9` |
| mc_c2.xml | `c2.android.av1.decoder` | `video/av01` | size 1920x1080, bitrate 1-120000000 | - | sì: `video/av01` |
| mc_c2.xml | `c2.android.mpeg2.decoder` | `video/mpeg2` | size 1920x1088, bitrate 1-20000000 | - | **no** |

I codec Google in `media_codecs_google_*.xml` (inclusi dal file del vendor) non sono elencati qui; quelli che l'app vede sono in `raw-caps.json` (`codecs`).
