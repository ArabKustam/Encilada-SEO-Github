// Linkshelf — a small Express app used as a repokit fixture.
const express = require("express");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const app = express();
const links = [];
let nextId = 1;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/links", (req, res) => res.json(links));

app.post("/api/links", (req, res) => {
  const { url, title } = req.body ?? {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "A valid http(s) url is required" });
  const link = { id: nextId++, url, title: title || url };
  links.push(link);
  res.status(201).json(link);
});

app.delete("/api/links/:id", (req, res) => {
  const index = links.findIndex((link) => link.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "Link not found" });
  links.splice(index, 1);
  res.status(204).end();
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Linkshelf listening on http://localhost:${PORT}`));
}

module.exports = app;
