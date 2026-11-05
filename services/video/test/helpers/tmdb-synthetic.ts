// Synthetic TMDB answers (ADR 0007 point 10: no real TMDB response in the repo). Titles, ids,
// overviews and paths are invented; only the shapes follow the public API documentation.
import type { Route } from './metadata-fetch.ts';
import { testImage } from './metadata-fetch.ts';

export const TOKEN = 'synthetic.tmdb.read.token.0123456789abcdef';

export const MOVIE = {
  id: 900001,
  title: 'Il Faro di Prova',
  original_title: 'The Test Lighthouse',
  release_date: '2019-03-14',
  overview: 'Un guardiano del faro scopre una luce che non dovrebbe esserci.',
  tagline: 'La luce mente.',
  genres: [
    { id: 18, name: 'Dramma' },
    { id: 9648, name: 'Mistero' },
  ],
  vote_count: 4321,
  external_ids: { imdb_id: 'tt9000001', wikidata_id: 'Q99000001' },
  translations: {
    translations: [
      { iso_639_1: 'it', iso_3166_1: 'IT', data: { title: 'Il Faro di Prova', overview: 'Un guardiano del faro scopre una luce che non dovrebbe esserci.', tagline: 'La luce mente.' } },
      { iso_639_1: 'en', iso_3166_1: 'US', data: { title: 'The Test Lighthouse', overview: 'A keeper finds a light.', tagline: '' } },
      { iso_639_1: 'de', iso_3166_1: 'DE', data: { title: 'Der Testleuchtturm', overview: 'x', tagline: '' } },
    ],
  },
  alternative_titles: { titles: [{ iso_3166_1: 'IT', title: 'Faro di Prova' }, { iso_3166_1: 'US', title: 'Test Lighthouse' }] },
  images: {
    posters: [
      { file_path: '/posterEN.jpg', iso_639_1: 'en', width: 2000, height: 3000, vote_average: 9 },
      { file_path: '/posterNULL.jpg', iso_639_1: null, width: 2000, height: 3000, vote_average: 5 },
      { file_path: '/posterIT2.jpg', iso_639_1: 'it', width: 1000, height: 1500, vote_average: 5 },
      { file_path: '/posterIT.jpg', iso_639_1: 'it', width: 2000, height: 3000, vote_average: 5 },
    ],
    backdrops: [{ file_path: '/backdrop.jpg', iso_639_1: null, width: 3840, height: 2160, vote_average: 5 }],
    logos: [
      { file_path: '/logo.svg', iso_639_1: 'it', width: 500, height: 200, vote_average: 9 },
      { file_path: '/logoEN.png', iso_639_1: 'en', width: 500, height: 200, vote_average: 5 },
    ],
  },
  credits: {
    cast: [
      { id: 7002, name: 'Bruna Seconda', character: 'Marta', order: 1 },
      { id: 7001, name: 'Aldo Primo', character: 'Il guardiano', order: 0 },
    ],
    crew: [
      { id: 7100, name: 'Regista Inventato', job: 'Director', department: 'Directing' },
      { id: 7101, name: 'Altro Nome', job: 'Producer', department: 'Production' },
    ],
  },
};

/** A movie without an Italian translation title nor overview: the title must not be written. */
export const MOVIE_NO_IT = {
  ...MOVIE,
  id: 900002,
  title: 'Untranslated Thing',
  original_title: 'Untranslated Thing',
  overview: '',
  tagline: '',
  translations: { translations: [{ iso_639_1: 'en', iso_3166_1: 'US', data: { title: 'Untranslated Thing', overview: 'English only overview.', tagline: '' } }] },
  external_ids: { imdb_id: 'tt9000002', wikidata_id: 'Q99000002' },
};

export const SHOW = {
  id: 800001,
  name: 'Serie di Prova',
  original_name: 'Testserie',
  first_air_date: '2017-12-01',
  overview: 'Una cittadina, una grotta, quattro famiglie.',
  tagline: '',
  genres: [{ id: 18, name: 'Dramma' }],
  vote_count: 999,
  created_by: [{ id: 7200, name: 'Creatrice Inventata' }],
  external_ids: { imdb_id: 'tt8000001', wikidata_id: 'Q98000001', tvdb_id: 880001 },
  translations: { translations: [{ iso_639_1: 'it', iso_3166_1: 'IT', data: { name: 'Serie di Prova', overview: 'Una cittadina, una grotta, quattro famiglie.', tagline: '' } }] },
  alternative_titles: { results: [{ iso_3166_1: 'DE', title: 'Die Testserie' }] },
  images: { posters: [{ file_path: '/showPoster.jpg', iso_639_1: null, width: 1000, height: 1500, vote_average: 5 }], backdrops: [], logos: [] },
  aggregate_credits: { cast: [{ id: 7300, name: 'Attore Seriale', roles: [{ character: 'Jonas', episode_count: 26 }], order: 0 }] },
  seasons: [{ season_number: 1, name: 'Stagione 1', overview: '', air_date: '2017-12-01', poster_path: '/s1.jpg' }],
};

export const SEASON_1 = {
  season_number: 1,
  name: 'Stagione 1',
  overview: '',
  air_date: '2017-12-01',
  poster_path: '/s1.jpg',
  episodes: [
    { episode_number: 1, name: 'Segreti di prova', overview: 'Un ragazzo scompare.', air_date: '2017-12-01', still_path: '/e1.jpg' },
    { episode_number: 2, name: 'Episodio 2', overview: '', air_date: '2017-12-01', still_path: '/e2.jpg' },
    { episode_number: 3, name: 'Terzo', overview: 'Tre.', air_date: '2017-12-01', still_path: null },
  ],
};
export const SEASON_1_EN = { ...SEASON_1, episodes: SEASON_1.episodes.map((e) => ({ ...e, overview: e.overview || `EN overview ${e.episode_number}` })) };

export const CONFIGURATION = {
  images: {
    secure_base_url: 'https://image.tmdb.org/t/p/',
    poster_sizes: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
    backdrop_sizes: ['w300', 'w780', 'w1280', 'original'],
    logo_sizes: ['w45', 'w92', 'w154', 'w185', 'w300', 'w500', 'original'],
    still_sizes: ['w92', 'w185', 'w300', 'original'],
  },
};

const searchResult = (m: typeof MOVIE) => ({ id: m.id, title: m.title, original_title: m.original_title, release_date: m.release_date, genre_ids: m.genres.map((g) => g.id), vote_count: m.vote_count });

/** Routes answering like api.themoviedb.org/3 and image.tmdb.org, only with the Bearer token. */
export function tmdbRoutes(opts: { token?: string; movies?: (typeof MOVIE)[]; shows?: (typeof SHOW)[] } = {}): Route[] {
  const token = opts.token ?? TOKEN;
  const movies = opts.movies ?? [MOVIE, MOVIE_NO_IT];
  const shows = opts.shows ?? [SHOW];
  const authed = (h: Record<string, string>) => h.Authorization === `Bearer ${token}`;
  return [
    {
      match: (u) => u.host === 'api.themoviedb.org',
      reply: (u, h) => {
        if (!authed(h)) return { status: 401, json: { success: false, status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' } };
        const p = u.pathname.replace(/^\/3/, '');
        if (p === '/authentication') return { json: { success: true, status_code: 1, status_message: 'Success.' } };
        if (p === '/configuration') return { json: CONFIGURATION };
        if (p === '/search/movie') {
          const q = (u.searchParams.get('query') ?? '').toLowerCase();
          return { json: { page: 1, results: movies.filter((m) => m.title.toLowerCase().includes(q)).map(searchResult), total_results: 1 } };
        }
        if (p === '/search/tv') {
          const q = (u.searchParams.get('query') ?? '').toLowerCase();
          return { json: { page: 1, results: shows.filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({ id: s.id, name: s.name, original_name: s.original_name, first_air_date: s.first_air_date, genre_ids: [18], vote_count: s.vote_count })) } };
        }
        const m = /^\/movie\/(\d+)$/.exec(p);
        if (m) {
          const movie = movies.find((x) => String(x.id) === m[1]);
          return movie ? { json: movie } : { status: 404, json: { status_code: 34 } };
        }
        const t = /^\/tv\/(\d+)$/.exec(p);
        if (t) {
          const show = shows.find((x) => String(x.id) === t[1]);
          return show ? { json: show } : { status: 404, json: { status_code: 34 } };
        }
        if (/^\/tv\/800001\/season\/1$/.test(p)) return { json: u.searchParams.get('language') === 'en-US' ? SEASON_1_EN : SEASON_1 };
        const f = /^\/find\/(.+)$/.exec(p);
        if (f) {
          const id = f[1];
          const movie = movies.find((x) => x.external_ids.imdb_id === id || x.external_ids.wikidata_id === id);
          const show = shows.find((x) => x.external_ids.imdb_id === id || x.external_ids.wikidata_id === id || String(x.external_ids.tvdb_id) === id);
          return { json: { movie_results: movie ? [searchResult(movie)] : [], tv_results: show ? [{ id: show.id, name: show.name }] : [] } };
        }
        return { status: 404, json: { status_code: 34 } };
      },
    },
    {
      match: (u) => u.host === 'image.tmdb.org',
      reply: async (u) => {
        const size = /^\/t\/p\/w(\d+)\//.exec(u.pathname)?.[1];
        const w = Number(size ?? 100);
        const seed = [...u.pathname].reduce((a, c) => a + c.charCodeAt(0), 0);
        return { bytes: await testImage(Math.min(w, 400), Math.round(Math.min(w, 400) * 1.5), seed), contentType: 'image/jpeg' };
      },
    },
  ];
}
