/* Lance un vrai serveur Kosmy Board sur un port libre, avec une base temporaire. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function startServer(env = {}) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const base = `http://localhost:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "kosmy-board-test-"));
  const proc = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, PUBLIC_URL: base, ...env } });
  let out = "";
  const setupCode = await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
      if (m) resolve(m[0]);
    });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", () => reject(new Error(out)));
  });
  return {
    base,
    setupCode,
    async stop() {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Un navigateur minimal : un pot de cookies, les redirections suivies à la main. */
export function browser(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  async function request(method, url, body, headers = {}) {
    const full = url.startsWith("http") ? url : base + url;
    const sameSite = full.startsWith(base);
    const res = await fetch(full, {
      method,
      redirect: "manual",
      headers: {
        ...(sameSite && jar.size ? { Cookie: cookieHeader() } : {}),
        ...(method !== "GET" ? { Origin: base } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    if (sameSite) store(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* page HTML */ }
    return { status: res.status, body: json, text, headers: res.headers, location: res.headers.get("location") };
  }
  /** Suit les redirections tant qu'elles restent sur le Board ; renvoie la dernière réponse. */
  async function follow(url, max = 10) {
    let r = await request("GET", url);
    for (let i = 0; i < max && r.location; i++) {
      const next = new URL(r.location, base).href;
      if (!next.startsWith(base)) return { ...r, location: next, external: true };
      if (r.location.includes("#")) return r; // une page de l'interface du Board
      r = await request("GET", next);
    }
    return r;
  }
  return { request, follow, jar };
}
