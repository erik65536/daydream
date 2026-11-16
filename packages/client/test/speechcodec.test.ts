import { afterEach, describe, expect, it, vi } from 'vitest';
import { sound } from '../src/sound';
import { GameClient } from '../src/net/game';

/** A socket that opens when told to, keeping what was sent. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

describe('telling the server how the player hears speech', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is not lost when it changes while the socket is connecting', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
    vi.spyOn(sound, 'unlock').mockImplementation(() => {});
    vi.spyOn(sound, 'unlocked', 'get').mockReturnValue(true);
    vi.spyOn(sound, 'codec').mockReturnValue('opus');
    // The pages are muted: speech is not heard until the game starts playing.
    let playing = false;
    vi.spyOn(sound, 'audible').mockImplementation(() => playing);

    const c = new GameClient('a_test');
    c.connect();
    const ws = FakeSocket.last;
    expect(ws.url).not.toContain('audio=');
    // The game view starts playing before the socket opens.
    playing = true;
    sound.setPlaying(true);
    ws.open();
    expect(ws.sent).toContainEqual({ t: 'audio', codec: 'opus' });
    sound.setPlaying(false);
  });
});
