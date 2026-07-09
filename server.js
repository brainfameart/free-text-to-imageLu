// Minimal static file server for ZenEngine (editor + player + runtime).
// No build step is used in this project — plain ES modules served as-is.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 5000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Redirect (not rewrite) so the browser's document URL actually becomes
  // /editor/... — otherwise the editor's relative imports/links (./main.js,
  // ./styles/editor.css) would resolve against "/" instead of "/editor/".
  if (urlPath === "/") {
    res.writeHead(302, { Location: "/editor/index.html" });
    res.end();
    return;
  }
  if (urlPath === "/play" || urlPath === "/player") {
    res.writeHead(302, { Location: "/player/play.html" });
    res.end();
    return;
  }

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ZenEngine server running on http://0.0.0.0:${PORT}`);
  console.log(`Editor: /  Player: /player/play.html`);
});
