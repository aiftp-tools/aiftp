import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FtpSrv from 'ftp-srv';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FtpAuthError,
  FtpClient,
  FtpConnectionError,
  FtpError,
  FtpNotFoundError,
  FtpTimeoutError,
  FtpTlsError,
  mapFtpError,
} from './ftp-client.js';

// ---------------------------------------------------------------------------
// Pure / unit tests
// ---------------------------------------------------------------------------

describe('FtpClient: construction', () => {
  it('requires host', () => {
    expect(
      () =>
        new FtpClient({
          host: '',
          user: 'u',
          password: 'p',
          protocol: 'ftps',
        }),
    ).toThrow(/host is required/);
  });

  it('requires user', () => {
    expect(
      () =>
        new FtpClient({
          host: 'h',
          user: '',
          password: 'p',
          protocol: 'ftps',
        }),
    ).toThrow(/user is required/);
  });

  it('requires password', () => {
    expect(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: intentional bad input
        new FtpClient({ host: 'h', user: 'u', password: undefined as any, protocol: 'ftps' }),
    ).toThrow(/password is required/);
  });

  it('defaults to ftps with requireTls=true', () => {
    const c = new FtpClient({ host: 'h', user: 'u', password: 'p' });
    expect(c.isConnected()).toBe(false);
  });

  it('refuses plain FTP when requireTls is true (default)', () => {
    expect(
      () =>
        new FtpClient({
          host: 'h',
          user: 'u',
          password: 'p',
          protocol: 'ftp',
        }),
    ).toThrow(FtpTlsError);
  });

  it('allows plain FTP when requireTls=false (with warning)', () => {
    const warnings: string[] = [];
    const c = new FtpClient({
      host: 'h',
      user: 'u',
      password: 'p',
      protocol: 'ftp',
      requireTls: false,
      onWarning: (line) => warnings.push(line),
    });
    expect(c.isConnected()).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/clear text/i);
  });

  it('explicitly setting requireTls=true rejects ftp protocol', () => {
    expect(
      () =>
        new FtpClient({
          host: 'h',
          user: 'u',
          password: 'p',
          protocol: 'ftp',
          requireTls: true,
        }),
    ).toThrow(FtpTlsError);
  });
});

describe('FtpClient: usage before connect', () => {
  it('upload throws FtpConnectionError without connect', async () => {
    const c = new FtpClient({ host: 'h', user: 'u', password: 'p' });
    await expect(c.upload('/tmp/x', '/x')).rejects.toBeInstanceOf(FtpConnectionError);
  });

  it('list throws FtpConnectionError without connect', async () => {
    const c = new FtpClient({ host: 'h', user: 'u', password: 'p' });
    await expect(c.list()).rejects.toBeInstanceOf(FtpConnectionError);
  });

  it('disconnect is safe to call without connect', async () => {
    const c = new FtpClient({ host: 'h', user: 'u', password: 'p' });
    await expect(c.disconnect()).resolves.toBeUndefined();
  });
});

describe('FtpError hierarchy', () => {
  it('FtpError carries cause', () => {
    const cause = new Error('root');
    const err = new FtpError('outer', { cause });
    expect(err.name).toBe('FtpError');
    expect(err.cause).toBe(cause);
  });

  it('FtpAuthError extends FtpError', () => {
    const err = new FtpAuthError('auth failed');
    expect(err).toBeInstanceOf(FtpError);
    expect(err.name).toBe('FtpAuthError');
  });

  it('FtpNotFoundError extends FtpError', () => {
    const err = new FtpNotFoundError('missing');
    expect(err).toBeInstanceOf(FtpError);
    expect(err.name).toBe('FtpNotFoundError');
  });

  it('FtpTlsError extends FtpError', () => {
    const err = new FtpTlsError('tls');
    expect(err).toBeInstanceOf(FtpError);
    expect(err.name).toBe('FtpTlsError');
  });

  it('FtpTlsError carries certificate diagnostic fields when provided', () => {
    const err = new FtpTlsError('tls altname mismatch', {
      certCommonName: '*.star.ne.jp',
      certAltNames: ['*.star.ne.jp', 'star.ne.jp'],
      actualHost: 'ftp.stars.ne.jp',
      recommendedAction:
        'After confirming server identity through another channel, set safety.verify_certificate=false in .aiftp.toml and retry.',
    });
    expect(err.certCommonName).toBe('*.star.ne.jp');
    expect(err.certAltNames).toEqual(['*.star.ne.jp', 'star.ne.jp']);
    expect(err.actualHost).toBe('ftp.stars.ne.jp');
    expect(err.recommendedAction).toContain('verify_certificate=false');
  });

  it('FtpConnectionError extends FtpError', () => {
    const err = new FtpConnectionError('conn');
    expect(err).toBeInstanceOf(FtpError);
    expect(err.name).toBe('FtpConnectionError');
  });
});

describe('mapFtpError: TLS hostname diagnostics', () => {
  it('extracts cert CN / SAN / host from ERR_TLS_CERT_ALTNAME_INVALID and adds a recommended action', () => {
    // Synthesize a Node TLS altname-mismatch error shape. Node's actual error
    // attaches `code`, `host`, `cert`, and `reason` properties.
    const rawError = Object.assign(
      new Error(
        "Hostname/IP does not match certificate's altnames: Host: ftp.stars.ne.jp. is not in the cert's altnames: DNS:*.star.ne.jp, DNS:star.ne.jp",
      ),
      {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        host: 'ftp.stars.ne.jp',
        cert: {
          subject: { CN: '*.star.ne.jp' },
          subjectaltname: 'DNS:*.star.ne.jp, DNS:star.ne.jp',
        },
      },
    );

    const mapped = mapFtpError(rawError, 'connect');

    expect(mapped).toBeInstanceOf(FtpTlsError);
    const tlsErr = mapped as FtpTlsError;
    expect(tlsErr.certCommonName).toBe('*.star.ne.jp');
    expect(tlsErr.certAltNames).toEqual(['*.star.ne.jp', 'star.ne.jp']);
    expect(tlsErr.actualHost).toBe('ftp.stars.ne.jp');
    expect(tlsErr.recommendedAction).toMatch(/verify_certificate\s*=\s*false/);
    expect(tlsErr.message).toContain('*.star.ne.jp');
    expect(tlsErr.message).toContain('ftp.stars.ne.jp');
  });

  it('does not attach altname diagnostics for unrelated TLS errors', () => {
    const rawError = Object.assign(new Error('expired'), {
      code: 'CERT_HAS_EXPIRED',
    });

    const mapped = mapFtpError(rawError, 'connect');

    expect(mapped).toBeInstanceOf(FtpTlsError);
    const tlsErr = mapped as FtpTlsError;
    expect(tlsErr.certCommonName).toBeUndefined();
    expect(tlsErr.actualHost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests with in-process ftp-srv
// ---------------------------------------------------------------------------

interface TestServer {
  port: number;
  root: string;
  username: string;
  password: string;
  stop: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to pick port')));
      }
    });
  });
}

async function startTestServer(): Promise<TestServer> {
  const port = await pickFreePort();
  const root = await mkdtemp(join(tmpdir(), 'aiftp-test-'));
  const username = 'testuser';
  const password = 'testpass';

  const url = `ftp://127.0.0.1:${port}`;
  // ftp-srv is CJS; the default export is the constructor.
  // biome-ignore lint/suspicious/noExplicitAny: third-party CJS interop
  const Ctor: any = (FtpSrv as any).default ?? FtpSrv;
  // biome-ignore lint/suspicious/noExplicitAny: FtpSrv has no published types
  const server: any = new Ctor({
    url,
    anonymous: false,
    pasv_url: '127.0.0.1',
    // The PASV range must sit OUTSIDE every platform's ephemeral port range,
    // otherwise the OS can hand one of these ports to an unrelated outbound
    // connection in the window between ftp-srv probing the port and binding
    // it -- and ftp-srv hangs instead of erroring when that bind fails (see
    // the `client-error` note below). Ephemeral ranges: Linux 32768-60999,
    // Windows/macOS 49152-65535. 21000-21100 is below all of them and above
    // the privileged <1024 range.
    //
    // The previous 50000-50100 sat inside all three, which is what made the
    // ftp-srv PASV race surface on Windows CI (Windows allocates ephemeral
    // ports sequentially, so a busy run sweeps straight through the range,
    // while Linux/macOS randomize and spread collisions thinner).
    pasv_min: 21000,
    pasv_max: 21100,
    // Silence the bundled bunyan logger; we don't need its noise in test output.
    log: {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return this;
      },
    },
  });

  server.on(
    'login',
    (
      data: { username: string; password: string },
      resolveLogin: (r: { root: string }) => void,
      rejectLogin: (e: Error) => void,
    ) => {
      if (data.username === username && data.password === password) {
        resolveLogin({ root });
      } else {
        rejectLogin(new Error('Bad credentials'));
      }
    },
  );

  // ftp-srv 4.6.3 swallows passive-mode setup failures: `Passive.setupServer`
  // calls `dataServer.listen(port, host, cb)` and treats `cb`'s first argument
  // as an error, but `net.Server.listen`'s callback is the 'listening' listener
  // and never receives one. Errors arrive on the 'error' event, which ftp-srv
  // only re-emits as `client-error` -- so a failed bind leaves that promise
  // forever pending and the client hangs waiting for the reply.
  //
  // Note basic-ftp negotiates EPSV, not PASV, so the reply to grep for in a
  // verbose log is `229 EPSV OK (|||port|)`. Both commands go through the same
  // ftp-srv `Passive` connector, so the defect above applies either way.
  //
  // We cannot fix ftp-srv from here (4.6.3 is the last release, 2023-10-09),
  // but surfacing `client-error` means the underlying EADDRINUSE shows up in
  // the CI output instead of a bare "Test timed out".
  server.on('client-error', ({ context, error }: { context: string; error: Error }) => {
    console.error(`[ftp-srv client-error] context=${context}: ${error.message}`);
  });

  await server.listen();

  return {
    port,
    root,
    username,
    password,
    stop: async () => {
      try {
        await server.close();
      } catch {
        // ignore
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

// Guard for the v0.12.0/v0.12.1 Windows flaky. The whole diagnosability fix
// rests on one assumption: when a socket stalls, the client's own timeout
// fires and raises a *typed* FtpTimeoutError rather than hanging until the
// runner kills it. This pins that assumption down.
//
// A stalled greeting is the same failure shape as the ftp-srv PASV hang --
// both leave the control socket idle waiting for a reply that never comes --
// so if this passes, a future PASV stall reports a real error too.
describe('FtpClient: a stalled server times out instead of hanging', () => {
  it('connect against a server that never sends a greeting rejects with FtpTimeoutError', async () => {
    const { createServer } = await import('node:net');
    // Accepts the TCP connection and then deliberately never sends the 220
    // greeting, so the control socket goes idle exactly as it does when
    // ftp-srv leaves a PASV reply forever pending.
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const address = silent.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('failed to bind the silent test server');
    }

    try {
      const client = new FtpClient({
        host: '127.0.0.1',
        port: address.port,
        user: 'testuser',
        password: 'testpass',
        protocol: 'ftp',
        requireTls: false,
        timeoutMs: 300,
      });

      await expect(client.connect()).rejects.toThrow(FtpTimeoutError);
      expect(client.isConnected()).toBe(false);
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe.sequential('FtpClient: integration with ftp-srv (plain FTP)', () => {
  let server: TestServer | undefined;
  let serverStartError: unknown;
  let workDir: string;

  beforeAll(async () => {
    try {
      server = await startTestServer();
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('listen EPERM')) {
        serverStartError = error;
        return;
      }
      throw error;
    }
  });

  afterAll(async () => {
    await server?.stop();
  });

  beforeEach(async (context) => {
    if (!server && serverStartError) {
      context.skip();
    }
    workDir = await mkdtemp(join(tmpdir(), 'aiftp-work-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function newClient(
    overrides: Partial<Parameters<typeof FtpClient.prototype.constructor>[0]> = {},
  ): FtpClient {
    if (!server) {
      throw new Error('ftp-srv integration server did not start');
    }
    return new FtpClient({
      host: '127.0.0.1',
      port: server.port,
      user: server.username,
      password: server.password,
      protocol: 'ftp',
      requireTls: false,
      // MUST stay well below vitest's testTimeout (5000ms by default). When the
      // two are equal, vitest kills the test before the client's own timeout
      // can raise a typed FtpTimeoutError, so every stall reports as an opaque
      // "Test timed out in 5000ms" with no cause attached. That is exactly why
      // the ftp-srv PASV hang went undiagnosed across v0.12.0 and v0.12.1.
      // Normal loopback operations here run in ~10-30ms, so 2s is ~60x headroom
      // while leaving 3s for the error to propagate and be asserted on.
      timeoutMs: 2_000,
      ...overrides,
    });
  }

  it('connect + disconnect round-trip', async () => {
    const client = newClient();
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('upload then download produces identical bytes', async () => {
    const client = newClient();
    await client.connect();
    try {
      const local = join(workDir, 'src.txt');
      const downloaded = join(workDir, 'dl.txt');
      const payload = 'hello, aiftp 🚀';
      await writeFile(local, payload);

      const result = await client.upload(local, 'src.txt');
      expect(result.remotePath).toBe('src.txt');
      expect(result.bytesUploaded).toBeGreaterThan(0);

      await client.download('src.txt', downloaded);
      const got = await readFile(downloaded, 'utf8');
      expect(got).toBe(payload);
    } finally {
      await client.disconnect();
    }
  });

  it('list returns uploaded file with type=file', async () => {
    const client = newClient();
    await client.connect();
    try {
      const local = join(workDir, 'a.txt');
      await writeFile(local, 'hi');
      await client.upload(local, 'a.txt');

      const entries = await client.list();
      const a = entries.find((e) => e.name === 'a.txt');
      expect(a).toBeDefined();
      expect(a?.type).toBe('file');
      expect(a?.size).toBe(2);
    } finally {
      await client.disconnect();
    }
  });

  it('size returns byte count of uploaded file', async () => {
    const client = newClient();
    await client.connect();
    try {
      const local = join(workDir, 'sized.txt');
      const payload = 'x'.repeat(123);
      await writeFile(local, payload);
      await client.upload(local, 'sized.txt');

      expect(await client.size('sized.txt')).toBe(123);
    } finally {
      await client.disconnect();
    }
  });

  it('exists returns true for present file, false for missing', async () => {
    const client = newClient();
    await client.connect();
    try {
      const local = join(workDir, 'e.txt');
      await writeFile(local, 'e');
      await client.upload(local, 'e.txt');

      expect(await client.exists('e.txt')).toBe(true);
      expect(await client.exists('nope.txt')).toBe(false);
    } finally {
      await client.disconnect();
    }
  });

  it('delete removes a file', async () => {
    const client = newClient();
    await client.connect();
    try {
      const local = join(workDir, 'd.txt');
      await writeFile(local, 'd');
      await client.upload(local, 'd.txt');
      expect(await client.exists('d.txt')).toBe(true);

      await client.delete('d.txt');
      expect(await client.exists('d.txt')).toBe(false);
    } finally {
      await client.disconnect();
    }
  });

  it('mkdir creates a remote directory (idempotent)', async () => {
    const client = newClient();
    await client.connect();
    try {
      await client.mkdir('sub/nested');
      const entries = await client.list();
      expect(entries.some((e) => e.name === 'sub' && e.type === 'directory')).toBe(true);

      // Calling again must not throw (ensureDir semantics).
      await client.mkdir('sub/nested');
    } finally {
      await client.disconnect();
    }
  });

  it('rejects wrong password with FtpAuthError', async () => {
    const client = newClient({ password: 'wrong-password' });
    await expect(client.connect()).rejects.toBeInstanceOf(FtpAuthError);
  });

  it('connect failure to nonexistent host throws FtpConnectionError', async () => {
    const bad = new FtpClient({
      host: '127.0.0.1',
      port: 1, // virtually guaranteed to refuse
      user: 'u',
      password: 'p',
      protocol: 'ftp',
      requireTls: false,
      timeoutMs: 1_000,
    });
    await expect(bad.connect()).rejects.toBeInstanceOf(FtpConnectionError);
  });

  it('delete of nonexistent file throws FtpNotFoundError', async () => {
    const client = newClient();
    await client.connect();
    try {
      await expect(client.delete('ghost.txt')).rejects.toBeInstanceOf(FtpNotFoundError);
    } finally {
      await client.disconnect();
    }
  });

  it('upload into a nested directory after mkdir', async () => {
    const client = newClient();
    await client.connect();
    try {
      await client.mkdir('public_html');
      const local = join(workDir, 'index.html');
      await writeFile(local, '<h1>hi</h1>');
      await client.upload(local, 'public_html/index.html');

      expect(await client.exists('public_html/index.html')).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  it('list returns empty array for new directory', async () => {
    const client = newClient();
    await client.connect();
    try {
      await client.mkdir('empty');
      const entries = await client.list('empty');
      expect(Array.isArray(entries)).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  it('reconnecting after disconnect works', async () => {
    const client = newClient();
    await client.connect();
    await client.disconnect();
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });
});
