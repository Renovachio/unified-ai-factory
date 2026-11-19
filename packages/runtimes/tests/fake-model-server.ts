import type { MockBehavior } from "../src/mock";

/** Minimal OpenAI-compatible streaming server on loopback acting as a "local model". It answers with role-appropriate JSON. */
export function startFakeModel(behavior: MockBehavior) {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/v1/models") return Response.json({ data: [{ id: "test-model" }] });
      if (u.pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      const body = (await req.json()) as { messages: Array<{ content: string }> };
      if (behavior === "fail") return new Response("boom", { status: 500 });
      if (behavior === "rate_limited") return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      const role = /^role: (\S+)/m.exec(user)?.[1] ?? "builder";
      const sha = /candidateSha MUST equal exactly ([a-f0-9]{40})/.exec(system)?.[1] ?? "0".repeat(40);
      let out: unknown = role.startsWith("review_")
        ? { reviewerRole: role.replace("review_", ""), candidateSha: sha, verdict: "pass", findings: [] }
        : { artifactUri: `local://${role}`, summary: "ok" };
      if (behavior === "wrong_sha") out = { ...(out as object), candidateSha: "f".repeat(40) };
      let text = JSON.stringify(out);
      if (behavior === "bad_output") text = "I am sorry, I cannot comply. {not json";
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(c) {
          if (behavior === "slow") {
            const t = setInterval(() => { try { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " " } }] })}\n\n`)); } catch { clearInterval(t); } }, 20);
            req.signal.addEventListener("abort", () => { clearInterval(t); try { c.close(); } catch { /* closed */ } });
            return;
          }
          const mid = Math.max(1, Math.floor(text.length / 2));
          for (const piece of [text.slice(0, mid), text.slice(mid)]) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
