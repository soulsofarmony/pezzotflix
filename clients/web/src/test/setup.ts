// Testing Library cleanup after each test (Vitest runs without globals, so it is not automatic), plus the
// browser APIs jsdom does not implement and the app calls.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The router restores the scroll position on navigation.
window.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
});
