// A real, separate OS process standing in for a managed service: serves 200 on /health. Marker arrives as an argument, like the real services.
const port = Number(process.argv[2]);
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
setInterval(() => undefined, 1 << 30);
