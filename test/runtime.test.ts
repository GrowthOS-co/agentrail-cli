import { describe, expect, it } from 'vitest';

import { isWebPage } from '../src/runtime.js';

describe('the pages login opens in a browser', () => {
  // The URL comes from the authorization server: anything but a web page
  // could open a file or start another program.
  it.each([
    ['https://auth.example.com/device?code=ABCD', true],
    ['http://127.0.0.1:8080/device', true],
    ['http://localhost/device', true],
    ['http://auth.example.com/device', false],
    ['file:///etc/passwd', false],
    ['ms-settings:privacy', false],
    ['not a url', false],
  ])('opens %s: %s', (url, opened) => {
    expect(isWebPage(url)).toBe(opened);
  });
});
