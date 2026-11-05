// Inline SVG icons (ADR 0005 point 5): no icon font, no network. Decorative by default (aria-hidden).
import type { ReactElement } from 'react';

const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  back: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  forward: 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z',
  replay10: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8zm-1.1 11H10v-3.3l-1 .3v-.7l1.8-.6h.1zm4.3-1.8c0 .3 0 .6-.1.8l-.3.6-.4.4-.6.1-.6-.1-.4-.4-.3-.6-.1-.8v-.7c0-.3 0-.6.1-.8l.3-.6.4-.4.6-.1.6.1.4.4.3.6.1.8zm-.9-.8-.1-.5-.1-.3-.2-.2h-.4l-.2.2-.1.3-.1.5v1l.1.5.1.3.2.2h.4l.2-.2.1-.3.1-.5z',
  forward10: 'M18 13a6 6 0 1 1-6-6v4l5-5-5-5v4a8 8 0 1 0 8 8zm-7.1 3H10v-3.3l-1 .3v-.7l1.8-.6h.1zm4.3-1.8c0 .3 0 .6-.1.8l-.3.6-.4.4-.6.1-.6-.1-.4-.4-.3-.6-.1-.8v-.7c0-.3 0-.6.1-.8l.3-.6.4-.4.6-.1.6.1.4.4.3.6.1.8zm-.9-.8-.1-.5-.1-.3-.2-.2h-.4l-.2.2-.1.3-.1.5v1l.1.5.1.3.2.2h.4l.2-.2.1-.3.1-.5z',
  volume: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zm2.5 0c0 .9-.2 1.8-.5 2.6l1.5 1.5A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.8v2.1a7 7 0 0 1 5 6.7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.2c-.7.5-1.4.9-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3-9-9zM12 4 9.9 6.1 12 8.2z',
  fullscreen: 'M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z',
  exitFullscreen: 'M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z',
  subtitles: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4zm10 6H4v-2h10zm6 0h-4v-2h4zm0-4H10v-2h10z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
  search: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
  edit: 'M3 17.2V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z',
  warning: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, label }: { name: IconName; size?: number; label?: string }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
