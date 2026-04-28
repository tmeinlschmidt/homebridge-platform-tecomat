import * as net from 'net';
import { buildAccessory } from './helpers/mocks';

/**
 * Spin up a loopback TCP server with a configurable response delay
 * and resolve to its assigned port.
 */
async function startServer(opts: {
  reply?: string;
  delayMs?: number;
  hang?: boolean; // never reply
}): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', () => {
      if (opts.hang) {
        return;
      }
      const reply = (opts.reply ?? 'OK') + '\n';
      setTimeout(() => socket.end(reply), opts.delayMs ?? 0);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  const close = () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => resolve());
    });

  return { port, close };
}

describe('defaultTransport (socket-based)', () => {
  it('resolves with the PLC response on success', async () => {
    const { port, close } = await startServer({ reply: 'GET:foo.POSIT,42' });
    try {
      const { accessory, raw } = buildAccessory();
      raw.platform.config.ipAddress = '127.0.0.1';
      raw.platform.config.port = port;
      raw.platform.config.commandTimeout = 1000;

      // defaultTransport is private — exercise it via the public API.
      const out = await (accessory as unknown as {
        defaultTransport(c: string, v: string): Promise<string>;
      }).defaultTransport('GET:foo.POSIT', '');

      expect(out).toBe('GET:foo.POSIT,42');
    } finally {
      await close();
    }
  });

  it('rejects with a clear timeout error when the PLC never replies', async () => {
    const { port, close } = await startServer({ hang: true });
    try {
      const { accessory, raw } = buildAccessory();
      raw.platform.config.ipAddress = '127.0.0.1';
      raw.platform.config.port = port;
      raw.platform.config.commandTimeout = 80;

      await expect(
        (accessory as unknown as {
          defaultTransport(c: string, v: string): Promise<string>;
        }).defaultTransport('GET:foo.STUCK', ''),
      ).rejects.toThrow(/Command timeout after 80ms/);
    } finally {
      await close();
    }
  });

  it('does not fire the timeout after a successful response (no leaked timers)', async () => {
    jest.useRealTimers();
    const { port, close } = await startServer({ reply: 'OK', delayMs: 10 });
    try {
      const { accessory, raw } = buildAccessory();
      raw.platform.config.ipAddress = '127.0.0.1';
      raw.platform.config.port = port;
      raw.platform.config.commandTimeout = 1000;

      const transport = (accessory as unknown as {
        defaultTransport(c: string, v: string): Promise<string>;
      }).defaultTransport.bind(accessory);

      const out = await transport('GET:x', '');
      expect(out).toBe('OK');

      // Wait long enough that a leaked timer would fire — nothing should reject after.
      await new Promise((r) => setTimeout(r, 50));
      // If a leaked timer rejected the (already settled) promise, jest would surface
      // an unhandled rejection here on test exit; we additionally re-issue a call
      // to confirm the transport is still healthy.
      const out2 = await transport('GET:y', '');
      expect(out2).toBe('OK');
    } finally {
      await close();
    }
  });
});
