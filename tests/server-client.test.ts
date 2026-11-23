import { createServer, type Server, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `server-only` throws outside a server build. Tests run in Node, so stub it.
vi.mock("server-only", () => ({}));

const { createServerSupabase } = await import("../src/lib/supabase/server");

let silent: Server;
let silentUrl = "";
const sockets = new Set<Socket>();
const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  silentUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise((resolve) => silent.close(resolve));
});

beforeEach(() => {
  process.env.SUPABASE_URL = silentUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-real-key";
});

afterEach(() => {
  if (saved.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
});

async function failureOf(run: () => PromiseLike<unknown>): Promise<{ name: string; ms: number }> {
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    return { name: (error as Error).name, ms: Date.now() - started };
  }
  throw new Error("The request was expected to fail.");
}

describe("createServerSupabase against a database that never answers", () => {
  it("stops after the timeout the caller passes", async () => {
    const client = createServerSupabase(300);
    const result = await failureOf(() => client.from("t").select("id").throwOnError().retry(false));

    expect(result.name).toBe("TimeoutError");
    expect(result.ms).toBeGreaterThanOrEqual(250);
    expect(result.ms).toBeLessThan(2_000);
  });

  it("stops at 3 seconds when no timeout is passed", async () => {
    const client = createServerSupabase();
    const result = await failureOf(() => client.from("t").select("id").throwOnError().retry(false));

    expect(result.name).toBe("TimeoutError");
    expect(result.ms).toBeGreaterThanOrEqual(2_800);
    expect(result.ms).toBeLessThan(6_000);
  });

  it("stops when the caller aborts, before a long timeout ends", async () => {
    const client = createServerSupabase(20_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await failureOf(() =>
      client.from("t").select("id").abortSignal(controller.signal).throwOnError().retry(false),
    );

    expect(result.name).toBe("AbortError");
    expect(result.ms).toBeLessThan(3_000);
  });
});
