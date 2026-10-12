// PAC Explorer: one page, hash routes, no build step. Everything PAC or
// other people wrote reaches the page as text nodes, never as HTML.

const main = document.getElementById("main");
const tabs = document.getElementById("tabs");
const modeEl = document.getElementById("mode");

/** An element: attributes, then children (strings become text nodes). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "href") el.setAttribute("href", safeHref(String(v)));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** Links go to our own routes, or to a few known sites, never anywhere a datum says. */
function safeHref(v) {
  return /^#\//.test(v) || /^https:\/\/(github\.com\/project-pac\/|projectpac\.net|docs\.projectpac\.net)/.test(v) ? v : "#/";
}

const short = (s, n = 10) => (typeof s === "string" && s.length > n + 1 ? `${s.slice(0, n)}…` : (s ?? ""));
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "–");
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 0) return `in ${dur(-s)}`;
  return s < 45 ? "just now" : `${dur(s)} ago`;
}
function dur(s) {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const time = (iso) => h("time", { datetime: iso, title: when(iso) }, ago(iso));

function copyBtn(text) {
  return h("button", { class: "copy", type: "button", title: "Copy", onclick: (e) => { navigator.clipboard?.writeText(text); e.currentTarget.textContent = "copied"; } }, "copy");
}
const hash = (s, n) => h("span", { class: "hash", title: s }, n ? short(s, n) : s);
const full = (s) => [hash(s), copyBtn(s)];
const sig = (ok, yes = "Verified", no = "Unverified") => h("span", { class: `badge ${ok ? "ok" : "bad"}` }, ok ? yes : no);

const ENDED_OK = new Set(["answered"]);
const ENDED_BAD = new Set(["failed", "expired"]);
const latest = (s) => s.turns?.at(-1);
function state(s) {
  const cls = ENDED_OK.has(s) ? "ok" : ENDED_BAD.has(s) ? "bad" : s === "current" ? "live" : s === "retired" ? "off" : "live";
  return h("span", { class: `badge ${cls}` }, s ?? "unknown");
}

function table(head, rows, empty = "Nothing yet.") {
  if (!rows.length) return h("p", { class: "empty" }, empty);
  return h("div", { class: "table" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => (c instanceof Node && c.tagName === "TD" ? c : h("td", {}, c))))))));
}
function sheet(pairs) {
  return h("dl", { class: "sheet" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}
const section = (title, color, ...kids) => [h("h2", { class: color ?? "" }, title), ...kids];
const crumb = (...parts) => h("div", { class: "crumb" }, parts.map((p, i) => [i ? " / " : "", p]));

// ---- Data ------------------------------------------------------------------

let network;
let mode = { mode: "public", private: false };
let meInfo;
let mine;

async function api(path) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`), { status: r.status });
  return r.json();
}
async function loadMine() {
  if (!mode.private) return undefined;
  mine ??= api("/api/me/sessions").catch(() => undefined);
  return mine;
}

const profileOf = (id) => network?.profiles.find((p) => p.id === id);
const nameOf = (id) => profileOf(id)?.name || (network?.tees.some((t) => t.id === id) ? `TEE ${short(id, 8)}` : short(id, 10));
const person = (id) => (profileOf(id) ? h("a", { href: `#/person/${id}` }, nameOf(id)) : h("span", { class: "hash", title: id }, short(id, 10)));
const teeLink = (id) => h("a", { href: `#/tee/${id}`, class: "mono" }, `TEE ${short(id, 8)}`);
const releaseOf = (codeIdentity) => network?.deployment.releases.find((r) => r.codeIdentity === codeIdentity);
const currentTee = () => network?.tees.find((t) => t.current) ?? network?.tees[0];

// ---- Pieces ----------------------------------------------------------------

function link(step, what, why, ok, href) {
  return h("div", { class: `link ${ok === true ? "ok" : ok === false ? "bad" : ""}` },
    h("div", { class: "step" }, step, ok === true ? h("span", { class: "badge ok" }, "") : ok === false ? h("span", { class: "badge bad" }, "") : null),
    href ? h("a", { class: "what", href }, what) : h("span", { class: "what" }, what),
    h("div", { class: "why" }, why),
    h("div", { class: "bars" }, h("span"), h("span"), h("span")));
}

/** Why a TEE's records can be trusted, link by link, each checked from public data. */
function chainFor(t) {
  const d = network.deployment;
  const rel = t.release ? d.releases.find((r) => r.measurement === t.release) : undefined;
  const load = [...t.loads].sort((a, b) => b.at.localeCompare(a.at))[0];
  return h("div", { class: "chain" },
    link("1 · Descriptor", `${d.name}, signed`, `by ${short(d.signer, 8)} · ${ago(d.at)}`, d.sigValid, "#/releases"),
    link("2 · Release", rel ? `${rel.version ?? short(rel.codeIdentity, 14)} · ${rel.status}` : "not in descriptor", rel ? `measurement ${short(rel.measurement, 8)}` : "its code isn't a release", rel ? true : false, rel ? `#/release/${rel.measurement}` : undefined),
    link("3 · Attestation", `TEE ${short(t.id, 8)}`, t.postIndex !== undefined ? `bulletin #${t.postIndex}${t.quote ? ` · quote ${short(t.quote.sha256, 8)}` : ""}` : "no announcement", t.postIndex !== undefined ? t.sigValid : false, `#/tee/${t.id}`),
    link("4 · Handover", t.current ? "home now" : t.handover ? "earlier home" : "no handover", t.handover ? `${t.handover.from ? `from ${short(t.handover.from, 8)}` : "first TEE"} · ${ago(t.handover.at)}` : "never took over", t.handover ? t.handover.sigValid : undefined, `#/tee/${t.id}`),
    link("5 · Program", load ? load.program : "nothing loaded", load ? `loaded ${ago(load.at)} · bulletin #${load.postIndex}` : "", load ? load.sigValid : undefined, load ? `#/post/${load.postIndex}` : undefined));
}

function activity(samples) {
  const box = h("div", { class: "activity" });
  if (!samples || samples.length < 2) {
    box.append(h("p", { class: "empty small" }, samples?.length ? `Sampling the vault's height every 5 minutes since ${when(samples[0].at)}. The chart fills in as samples arrive.` : "This explorer samples the vault's height every 5 minutes; the chart fills in as samples arrive."));
    return box;
  }
  const deltas = samples.slice(1).map((s, i) => ({ at: s.at, n: Math.max(0, s.height - samples[i].height) }));
  const max = Math.max(1, ...deltas.map((d) => d.n));
  const w = 1000, hgt = 120, bw = w / deltas.length;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Vault writes per sample, ${deltas.length} samples, peak ${max}`);
  deltas.forEach((d, i) => {
    const r = document.createElementNS(ns, "rect");
    const bh = Math.max(d.n ? 2 : 0, (d.n / max) * (hgt - 4));
    r.setAttribute("x", String(i * bw + bw * 0.12));
    r.setAttribute("width", String(Math.max(1, bw * 0.76)));
    r.setAttribute("y", String(hgt - bh));
    r.setAttribute("height", String(bh));
    r.setAttribute("fill", "#3366cc");
    const t = document.createElementNS(ns, "title");
    t.textContent = `${d.n} writes · ${when(d.at)}`;
    r.append(t);
    svg.append(r);
  });
  const total = samples.at(-1).height - samples[0].height;
  box.append(svg, h("div", { class: "axis" }, h("span", {}, when(samples[0].at)), h("span", {}, `${fmt(total)} writes · peak ${fmt(max)} per 5 min`), h("span", {}, "now")));
  return box;
}

const appRelease = (v) => network?.app?.releases?.find((r) => r.version === v);
const mb = (n) => (typeof n === "number" ? `${(n / 1e6).toFixed(1)} MB` : "–");
const KINDS = { cli: "pac (CLI)", app: "Mac app", signature: "update signature", other: "file" };
function contents(r) {
  const cli = r.files.filter((f) => f.kind === "cli").length;
  const app = r.files.some((f) => f.kind === "app");
  return [cli ? `pac for ${cli} platform${cli === 1 ? "" : "s"}` : "", app ? "Mac app" : ""].filter(Boolean).join(" + ") || `${r.files.length} files`;
}
const newerThan = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** The latest app release, and, on the local explorer, whether this machine's pac is behind it. */
function releaseBanner() {
  const app = network.app;
  const r = app?.latest ? appRelease(app.latest) : undefined;
  if (!r) return null;
  const behind = meInfo?.version && newerThan(r.version, meInfo.version);
  return h("a", { class: `release${behind ? " behind" : ""}`, href: `#/app/${r.version}` },
    h("span", { class: "tag" }, "Latest release"),
    h("b", {}, `PAC ${r.version}`),
    h("span", {}, "released ", time(r.publishedAt)),
    sig(r.sigValid, "signed with PAC's release key", "signature doesn't verify"),
    behind ? h("span", { class: "nudge" }, `Your pac is ${meInfo.version}: run pac upgrade`) : h("span", { class: "muted" }, "install.sh, or pac upgrade"));
}

function quoteCell(q) {
  return [
    h("div", {}, [q.backend, q.platform].filter(Boolean).join(" · ") || "quote", h("span", { class: "muted small" }, ` · ${fmt(q.bytes)} bytes · ${fmt(q.events)} boot events${q.collateral ? " · collateral included" : ""}`)),
    h("div", { class: "small" }, "sha256 ", hash(q.sha256), copyBtn(q.sha256)),
  ];
}

function postsTable(posts) {
  return table(["#", "Type", "TEE", "What", "Posted", "Signature"], posts.map((p) => [
    h("td", { class: "num" }, h("a", { href: `#/post/${p.index}` }, String(p.index))),
    p.type === "tee_announcement" ? "TEE announcement" : p.type === "program_loaded" ? "Program loaded" : p.type,
    p.tee ? teeLink(p.tee) : "–",
    p.type === "tee_announcement" ? h("span", { class: "mono" }, p.codeIdentity ? short(p.codeIdentity, 18) : "") : h("span", { class: "mono" }, p.program ?? ""),
    time(p.postedAt),
    sig(p.sigValid),
  ]));
}

function sessionRows(sessions) {
  return sessions.map((x) => {
    const t = latest(x);
    return [
      h("a", { href: `#/session/${x.id}`, class: "clip" }, x.group ? `${x.group.name} · run ${x.group.run}` : t?.prompt || x.id),
      state(t?.status),
      (x.you ?? []).join(", "),
      String(x.people?.length ?? 0),
      x.results?.length ? h("span", { class: "badge ok" }, "released") : x.needsYou ? h("span", { class: "badge live" }, "waits on you") : "",
      time(t?.updatedAt ?? t?.createdAt),
    ];
  });
}
const SESSION_HEAD = ["Prompt", "State", "You", "People", "", "Updated"];

function privateNotice(what) {
  return h("div", { class: "notice" },
    h("h1", {}, what ?? "Sessions are private"),
    h("p", { class: "lede" }, "Every PAC session is encrypted to the people in it: its prompts, who's in it, the files it read and its results. Nobody else can read it, this explorer included. That's the point of PAC."),
    h("p", {}, "If you're in this session, see every detail of it with your own keys, on your own machine:"),
    h("pre", {}, "git clone https://github.com/project-pac/pac-interfaces\ncd pac-interfaces && npm install\nnode bin/main.ts explorer"),
    h("p", { class: "small muted" }, "It opens this explorer at 127.0.0.1, reading your sessions through your own pac. Nothing leaves your machine."));
}

// ---- Pages -----------------------------------------------------------------

async function overview() {
  const d = network.deployment;
  const cur = currentTee();
  const releases = d.releases;
  const yours = await loadMine();
  const sixth = yours
    ? h("a", { class: "stat red", href: "#/sessions" }, h("span", { class: "n" }, fmt(yours.length)), h("span", { class: "k" }, "Your sessions"), h("span", { class: "d" }, `${yours.filter((x) => x.needsYou).length} wait on you`))
    : h("a", { class: "stat red", href: "#/tees" }, h("span", { class: "n" }, fmt(network.tees.filter((t) => t.handover).length)), h("span", { class: "k" }, "Handovers"), h("span", { class: "d" }, "TEE to TEE"));
  const out = [
    h("h1", {}, `${d.name} network`),
    h("p", { class: "lede" }, "Descriptor signed ", time(d.at), " by its signer ", sig(d.sigValid, "valid", "invalid"), " · read ", time(network.at)),
    network.problems.length ? h("div", { class: "warn" }, `Checks that failed: ${network.problems.join(", ")}`) : null,
    releaseBanner(),
    h("div", { class: "hero" },
      h("div", { class: "height" }, h("div", { class: "label" }, "Vault height"), h("div", { class: "n" }, fmt(network.height)), h("div", { class: "sub" }, "accepted writes, every person's and every TEE's")),
      h("div", { class: "stats" },
        h("a", { class: "stat", href: "#/tees" }, h("span", { class: "n" }, fmt(network.tees.length)), h("span", { class: "k" }, "TEEs"), h("span", { class: "d" }, cur ? `home: ${short(cur.id, 8)}` : "")),
        h("a", { class: "stat green", href: "#/releases" }, h("span", { class: "n" }, fmt(releases.length)), h("span", { class: "k" }, "Releases"), h("span", { class: "d" }, `${releases.filter((r) => r.status === "current").length} current`)),
        h("a", { class: "stat red", href: "#/programs" }, h("span", { class: "n" }, fmt(network.programs.length)), h("span", { class: "k" }, "Program bundles"), h("span", { class: "d" }, `${network.programs.filter((p) => p.status === "current").length} current`)),
        h("a", { class: "stat", href: "#/people" }, h("span", { class: "n" }, fmt(network.profiles.length)), h("span", { class: "k" }, "People"), h("span", { class: "d" }, "public profiles")),
        h("a", { class: "stat green", href: "#/bulletin" }, h("span", { class: "n" }, fmt(network.posts.length)), h("span", { class: "k" }, "Bulletin posts"), h("span", { class: "d" }, network.posts.length ? `last ${ago(network.posts.at(-1).postedAt)}` : "")),
        sixth)),
    ...(cur ? section("Proof chain · the TEE that's home now", "green", chainFor(cur)) : []),
    ...section("Activity", null, activity((await api("/api/activity").catch(() => ({ samples: [] }))).samples)),
  ];
  if (yours) out.push(...section("Your latest sessions", "green", table(SESSION_HEAD, sessionRows(yours.slice(0, 6)), "You're in no sessions yet.")));
  out.push(...section("Latest on the bulletin", "red", postsTable([...network.posts].reverse().slice(0, 6))));
  out.push(...section("What's public here, and what isn't", null, publicPrivate()));
  return out;
}

function publicPrivate() {
  return h("div", { class: "cols" },
    h("div", { class: "card public" }, h("h3", {}, "Public: anyone can check it"), h("ul", {},
      h("li", {}, "The deployment descriptor: releases, their measurements, signed"),
      h("li", {}, "The bulletin: each TEE's attestation and every program it loads"),
      h("li", {}, "The vault's height, profiles, TEE handovers, program manifests"))),
    h("div", { class: "card private" }, h("h3", {}, "Private: only the people in a session"), h("ul", {},
      h("li", {}, "A prompt, who's in it, and which files it read"),
      h("li", {}, "PAC's questions, the answers, approvals, results"),
      h("li", {}, mode.private ? "Yours are under Your sessions, read through your own pac" : "Yours: run the explorer on your own machine"))));
}

function teesPage() {
  return [
    h("h1", {}, "TEEs"),
    h("p", { class: "lede" }, "Each confidential computer PAC has run on. A TEE posts its attestation to the bulletin before anyone grants it a key; the one that's home now writes every record."),
    table(["TEE", "Release", "Announced", "Attestation", "Handover", "Home"], network.tees.map((t) => [
      teeLink(t.id),
      t.release ? h("a", { href: `#/release/${t.release}` }, t.version ?? short(t.codeIdentity, 14)) : h("span", { class: "muted" }, "unknown"),
      t.announcedAt ? time(t.announcedAt) : "–",
      sig(t.sigValid),
      t.handover ? sig(t.handover.sigValid) : "–",
      t.current ? h("span", { class: "badge live" }, "home") : "",
    ])),
  ];
}

function teePage(id) {
  const t = network.tees.find((x) => x.id === id);
  if (!t) return [h("h1", {}, "No such TEE"), h("p", { class: "empty" }, "No announcement or handover names it.")];
  return [
    crumb(h("a", { href: "#/tees" }, "TEEs"), short(id, 8)),
    h("h1", {}, `TEE ${short(id, 12)}`, " ", t.current ? h("span", { class: "badge live" }, "home") : null),
    ...section("Proof chain", "green", chainFor(t)),
    ...section("Announcement", null, sheet([
      ["Id", full(t.id)],
      ["Code identity", t.codeIdentity ? full(t.codeIdentity) : "–"],
      ["Release", t.release ? [h("a", { href: `#/release/${t.release}` }, t.version ?? "release"), " ", state(t.releaseStatus)] : "not in the descriptor"],
      ["Platform", t.platform ?? "–"],
      ["Announced", t.announcedAt ? [when(t.announcedAt), " · ", time(t.announcedAt)] : "–"],
      ["Bulletin post", t.postIndex !== undefined ? h("a", { href: `#/post/${t.postIndex}` }, `#${t.postIndex}`) : "–"],
      ["Attestation quote", t.quote ? quoteCell(t.quote) : "–"],
      ["Signature", sig(t.sigValid, "signed by this TEE", "doesn't verify")],
    ])),
    h("p", { class: "small muted" }, "The quote's own chain (Intel's DCAP) is checked by each person's pac before it grants this TEE a key; this page checks the TEE's signature on what it posted."),
    ...section("Handover", null, t.handover ? sheet([
      ["Took over from", t.handover.from ? teeLink(t.handover.from) : "nobody: the first TEE"],
      ["As of vault seq", fmt(t.handover.asOf)],
      ["At", [when(t.handover.at), " · ", time(t.handover.at)]],
      ["Signature", sig(t.handover.sigValid)],
    ]) : h("p", { class: "empty" }, "It never took over as home.")),
    ...section("Programs loaded", "red", table(["Program", "Loaded", "Post", "Signature"], t.loads.map((l) => [h("span", { class: "mono" }, l.program), time(l.at), h("a", { href: `#/post/${l.postIndex}` }, `#${l.postIndex}`), sig(l.sigValid)]))),
  ];
}

function releasesPage() {
  const d = network.deployment;
  const app = network.app ?? { releases: [] };
  return [
    h("h1", {}, "Releases"),
    h("p", { class: "lede" }, "Three kinds, each checked here: the app people install, the code PAC's computer may run, and the PAC program it loads."),
    ...section("The PAC app", "green",
      h("p", { class: "small muted" }, "Every version's checksums are signed by the release key the pac CLI pins (", hash(app.key ?? "", 12), "). The CDN lists no versions, so each one it keeps is found and checked."),
      table(["Version", "Released", "What's in it", "Checksums"], app.releases.map((r) => [
        [h("a", { href: `#/app/${r.version}` }, r.version), r.latest ? [" ", h("span", { class: "badge live" }, "latest")] : null],
        r.publishedAt ? [when(r.publishedAt), h("span", { class: "muted small" }, ` · ${ago(r.publishedAt)}`)] : "–",
        contents(r),
        sig(r.sigValid, "signed", "unsigned"),
      ]), "No releases found.")),
    ...section("PAC's computer", null, h("p", { class: "small muted" }, "The code PAC's computer may run, each pinned by its measurement in the descriptor ", sig(d.sigValid, "signed", "unsigned"), " by ", hash(d.signer, 10), ".")),
    table(["Version", "Code identity", "Status", "Platform", "Since", "Commit"], d.releases.map((r) => [
      h("a", { href: `#/release/${r.measurement}` }, r.version ?? short(r.measurement, 10)),
      h("span", { class: "mono" }, short(r.codeIdentity, 22)),
      state(r.status),
      r.platform ?? "–",
      time(r.at),
      r.commit ? h("a", { href: `https://github.com/project-pac/pac-system/commit/${r.commit}`, class: "mono" }, short(r.commit, 8)) : "–",
    ])),
    ...section("The PAC program's bundles", "red", table(["Bundle", "Status", "Since"], d.pac.map((p) => [h("a", { href: `#/program/${p.sha256}`, class: "mono" }, short(p.sha256, 16)), state(p.status), time(p.at)]))),
  ];
}

function appPage(v) {
  const r = appRelease(v);
  if (!r) return [h("h1", {}, `No PAC ${v}`), h("p", { class: "empty" }, "The CDN keeps no release by that version.")];
  const base = "https://cdn.projectpac.net/releases";
  return [
    crumb(h("a", { href: "#/releases" }, "Releases"), `PAC ${r.version}`),
    h("h1", {}, `PAC ${r.version} `, r.latest ? h("span", { class: "badge live" }, "latest") : null),
    sheet([
      ["Released", r.publishedAt ? [when(r.publishedAt), " · ", time(r.publishedAt)] : "–"],
      ["What's in it", contents(r)],
      ["SHA256SUMS", [hash(r.sumsSha256), copyBtn(r.sumsSha256)]],
      ["Signature", [sig(r.sigValid, "signed by PAC's release key", "doesn't verify"), h("span", { class: "muted small" }, " the key pac pins to check its upgrades: "), hash(network.app.key, 16)]],
      r.latest && ["latest.json", r.manifestMatches ? h("span", { class: "badge ok" }, "names exactly the signed checksums") : h("span", { class: "badge bad" }, "differs from the signed checksums")],
      ["Get it", h("code", {}, r.latest ? "curl -fsSL https://cdn.projectpac.net/install.sh | sh   ·   or: pac upgrade" : "pac upgrade installs the latest")],
      meInfo?.version && ["This machine", meInfo.version === r.version ? h("span", { class: "badge ok" }, "runs this version") : h("span", {}, `runs pac ${meInfo.version}`)],
    ]),
    ...section("Files", null, table(["Kind", "Platform", "File", "Size", "sha256"], r.files.map((f) => [
      KINDS[f.kind] ?? f.kind,
      f.platform,
      h("span", { class: "mono" }, f.name),
      h("td", { class: "num" }, mb(f.size)),
      [hash(f.sha256, 16), copyBtn(f.sha256)],
    ]))),
    h("p", { class: "small muted" }, "Check a download yourself: ", h("code", {}, `curl -fsSLO ${base}/${r.version}/SHA256SUMS && shasum -a 256 -c SHA256SUMS --ignore-missing`)),
  ];
}

function releasePage(m) {
  const r = network.deployment.releases.find((x) => x.measurement === m);
  if (!r) return [h("h1", {}, "No such release")];
  const tees = network.tees.filter((t) => t.release === m);
  return [
    crumb(h("a", { href: "#/releases" }, "Releases"), r.version ?? short(m, 8)),
    h("h1", {}, `Release ${r.version ?? short(m, 10)} `, state(r.status)),
    sheet([
      ["Measurement", full(r.measurement)],
      ["Code identity", full(r.codeIdentity)],
      ["Commit", r.commit ? [h("a", { href: `https://github.com/project-pac/pac-system/commit/${r.commit}`, class: "mono" }, r.commit), copyBtn(r.commit)] : "–"],
      ["Platform", [r.platform ?? "–", r.backend ? ` · ${r.backend}` : "", r.teeMode ? ` · ${r.teeMode}` : ""]],
      ["Image", r.imageSha256 ? full(r.imageSha256) : "–"],
      ["Compose", r.composeHash ? full(r.composeHash) : "–"],
      ["Since", [when(r.at), " · ", time(r.at)]],
      ["Events", fmt(r.events)],
      ["Egress", r.egress !== undefined ? h("code", {}, JSON.stringify(r.egress)) : "–"],
    ]),
    ...section("TEEs that ran it", "green", table(["TEE", "Announced", "Home"], tees.map((t) => [teeLink(t.id), time(t.announcedAt), t.current ? h("span", { class: "badge live" }, "home") : ""]), "None announced it.")),
  ];
}

function programsPage() {
  return [
    h("h1", {}, "Programs"),
    h("p", { class: "lede" }, "Program bundles with public manifests: what each may reach, beside the digest of its sources. The sources themselves are for the readers their publisher names."),
    table(["Program", "Publisher", "Bundle", "Status", "Written", "Manifest"], network.programs.map((p) => [
      h("a", { href: `#/program/${p.sha256}` }, p.name), person(p.publisher), h("span", { class: "mono" }, short(p.sha256, 12)), p.status ? state(p.status) : "–", time(p.writtenAt), sig(p.sigValid),
    ])),
  ];
}

function programPage(sha) {
  const p = network.programs.find((x) => x.sha256 === sha);
  const listed = network.deployment.pac.find((x) => x.sha256 === sha);
  if (!p && !listed) return [h("h1", {}, "No such program")];
  return [
    crumb(h("a", { href: "#/programs" }, "Programs"), short(sha, 8)),
    h("h1", {}, p ? `${p.name} ` : "Bundle ", p?.status ? state(p.status) : listed ? state(listed.status) : null),
    sheet([
      ["Bundle sha256", full(sha)],
      p && ["Publisher", [person(p.publisher), " ", hash(p.publisher, 12)]],
      p?.content && ["Sources digest", full(p.content)],
      p && ["Written", [when(p.writtenAt), " · ", time(p.writtenAt)]],
      p && ["Manifest", sig(p.sigValid, "signed by its publisher", "doesn't verify")],
      p?.egress !== undefined && ["Egress", h("code", {}, JSON.stringify(p.egress))],
      p?.build !== undefined && ["Build", h("code", {}, JSON.stringify(p.build))],
      listed && ["In the descriptor", [state(listed.status), " since ", time(listed.at)]],
    ]),
    ...section("Loads", "red", table(["TEE", "Loaded", "Post"], network.tees.flatMap((t) => t.loads.filter((l) => l.program.endsWith(`@${sha.slice(0, 12)}`)).map((l) => [teeLink(t.id), time(l.at), h("a", { href: `#/post/${l.postIndex}` }, `#${l.postIndex}`)])), "No TEE posted a load of it.")),
  ];
}

function peoplePage() {
  return [
    h("h1", {}, "People"),
    h("p", { class: "lede" }, "Public profiles: a name, and the key others encrypt to. PAC keeps no directory; these are the profiles anyone can read from the vault."),
    table(["Name", "Id", "Since", "Profile"], network.profiles.map((p) => [h("a", { href: `#/person/${p.id}` }, p.name || "(no name)"), h("span", { class: "mono" }, short(p.id, 16)), time(p.at), sig(p.sigValid)])),
  ];
}

async function personPage(id) {
  const p = profileOf(id);
  if (!p) return [h("h1", {}, "No such profile")];
  const yours = await loadMine();
  const shared = yours?.filter((x) => x.people?.some((p) => p.user === id)) ?? [];
  return [
    crumb(h("a", { href: "#/people" }, "People"), p.name),
    h("h1", {}, p.name || "(no name)"),
    sheet([
      ["Id", full(p.id)],
      ["Encryption key", full(p.enc)],
      ["Profile version", fmt(p.version)],
      ["Since", [when(p.at), " · ", time(p.at)]],
      ["Signature", sig(p.sigValid, "signed by its own key", "doesn't verify")],
      p.id === network.deployment.publisher && ["Role", h("span", { class: "badge live" }, "PAC's publisher")],
    ]),
    ...(yours ? section(`Your sessions with ${p.name}`, "green", table(SESSION_HEAD, sessionRows(shared), "No sessions with them.")) : []),
  ];
}

function bulletinPage() {
  return [h("h1", {}, "Bulletin"), h("p", { class: "lede" }, "PAC's public, append-only log. Every TEE posts its keys and attestation here, and each program before it runs it."), postsTable([...network.posts].reverse())];
}

function postPage(i) {
  const p = network.posts.find((x) => x.index === Number(i));
  if (!p) return [h("h1", {}, "No such post")];
  return [
    crumb(h("a", { href: "#/bulletin" }, "Bulletin"), `#${p.index}`),
    h("h1", {}, `Post #${p.index}`),
    sheet([
      ["Type", p.type],
      ["Posted", [when(p.postedAt), " · ", time(p.postedAt)]],
      p.tee && ["By", [teeLink(p.tee), " ", hash(p.tee, 16)]],
      p.at && ["Says it's from", when(p.at)],
      p.codeIdentity && ["Code identity", full(p.codeIdentity)],
      p.program && ["Program", h("span", { class: "mono" }, p.program)],
      p.quote && ["Attestation quote", quoteCell(p.quote)],
      ["Signature", sig(p.sigValid, "signed by its TEE", "doesn't verify")],
    ]),
  ];
}

async function sessionsPage() {
  if (!mode.private) return [privateNotice("Your sessions")];
  const all = await loadMine();
  if (!all) return [h("h1", {}, "Your sessions"), h("p", { class: "warn" }, "Your pac didn't answer. Is PAC running? Try `pac status`.")];
  return [
    h("h1", {}, "Your sessions"),
    h("p", { class: "lede" }, "Every session you're in, read through your own pac on this machine. Only you see this page."),
    table(SESSION_HEAD, sessionRows(all), "You're in no sessions yet. Ask PAC something."),
  ];
}

const KIND = { question: "question", access: "access to a file", approval: "approval", data: "group submission" };

async function sessionPage(id) {
  if (!mode.private) return [crumb("Sessions", id), privateNotice("This session is private")];
  let d;
  try {
    d = await api(`/api/me/session/${encodeURIComponent(id)}`);
  } catch (e) {
    return [crumb(h("a", { href: "#/sessions" }, "Your sessions"), id), h("h1", {}, "Not one of yours"), h("p", { class: "empty" }, e.status === 404 ? "Your pac has no session by that id: you aren't in it, or it doesn't exist." : "Your pac didn't answer.")];
  }
  const x = d.session;
  const names = new Map((x.people ?? []).map((p) => [p.user, p.name]));
  const who = (u) => (profileOf(u) ? person(u) : h("span", { title: u }, names.get(u) ?? short(u, 10)));
  const agent = x.agent ?? {};
  const rel = agent.codeIdentity ? releaseOf(agent.codeIdentity) : undefined;
  const ranOn = network.tees.filter((t) => t.codeIdentity && t.codeIdentity === agent.codeIdentity);
  const first = x.turns?.[0];
  const last = latest(x);
  return [
    crumb(h("a", { href: "#/sessions" }, "Your sessions"), h("span", { class: "mono" }, x.ref ?? short(x.id, 16))),
    x.group ? h("div", { class: "meta" }, h("span", { class: "badge live" }, "group"), h("b", {}, x.group.name), `run ${x.group.run}`) : null,
    h("div", { class: "goal" }, first?.prompt ?? "(no prompt)"),
    h("div", { class: "meta" }, state(last?.status), last?.failure ? h("span", { class: "badge bad" }, last.failure) : null, first ? h("span", {}, "asked by ", who(first.by)) : null, first ? h("span", {}, "started ", time(first.createdAt)) : null, h("span", {}, "you: ", (x.you ?? []).join(", ")), h("span", {}, hash(x.id), copyBtn(x.id))),
    ...section("Proof", "green", sheet([
      ["Answered by", agent.codeIdentity ? [h("span", { class: "mono" }, agent.codeIdentity), " ", rel ? [h("a", { href: `#/release/${rel.measurement}` }, `release ${rel.version ?? ""}`), " ", state(rel.status)] : h("span", { class: "badge bad" }, "not a known release")] : "–"],
      ["Measurement", agent.measurement ? [hash(agent.measurement), rel ? (rel.measurement === agent.measurement ? h("span", { class: "badge ok" }, "matches the signed descriptor") : h("span", { class: "badge bad" }, "differs from the descriptor")) : null] : "–"],
      ["Attested TEEs on that code", ranOn.length ? ranOn.map((t, i) => [i ? ", " : "", teeLink(t.id), t.sigValid ? "" : " (unverified)", t.current ? " (home)" : ""]) : "–"],
    ])),
    ...section("Turns", null, h("ol", { class: "timeline" }, (x.turns ?? []).map((t) => h("li", { class: ENDED_OK.has(t.status) ? "done" : ENDED_BAD.has(t.status) ? "end" : "" },
      h("b", {}, `Turn ${t.n} · ${t.status}`), t.failure ? ` (${t.failure})` : "", " ", h("span", { class: "when" }, `${when(t.createdAt)} · updated ${ago(t.updatedAt)}`),
      h("div", {}, who(t.by), ": ", h("span", { class: "muted" }, t.prompt)),
      t.with?.length ? h("div", { class: "small muted" }, "named: ", t.with.map((u, i) => [i ? ", " : "", who(u)])) : null,
      t.gathered ? h("div", { class: "small muted" }, `gathered ${t.gathered.in} of ${t.gathered.of}`) : null,
      t.deadline ? h("div", { class: "small muted" }, `questions close ${when(t.deadline)}`) : null)))),
    ...(d.results?.length ? section("Your results", "green", d.results.map((r) => h("div", {}, x.turns.length > 1 ? h("div", { class: "meta" }, `turn ${r.turn}`) : null, h("div", { class: "text" }, r.text || "(empty)")))) : []),
    ...(d.asks?.length ? section("PAC's asks to you", "red", d.asks.map((a) => h("div", {}, h("div", { class: "meta" }, state(a.status), KIND[a.body?.kind] ?? a.body?.kind, `turn ${a.turn}`, a.createdAt ? time(a.createdAt) : null), h("div", { class: "text" }, a.text ?? a.body?.text ?? "")))) : []),
    ...section("People", null, table(["Name", "Id", "Named in a turn"], (x.people ?? []).map((p) => [who(p.user), h("span", { class: "mono" }, short(p.user, 12)), (x.turns ?? []).some((t) => t.with?.includes(p.user) || t.by === p.user) ? "yes" : ""]), "No one else.")),
    ...section("Files of yours PAC read", null, table(["File", "Version", "Turn"], (x.read ?? []).map((r) => [h("span", { class: "mono" }, r.file), String(r.version), String(r.turn)]), "None of your files.")),
    h("details", { class: "raw" }, h("summary", {}, "Raw, as pac session prints it"), h("pre", {}, JSON.stringify(x, null, 2))),
  ];
}

async function searchPage(raw) {
  const q = decodeURIComponent(raw).trim();
  const lower = q.toLowerCase();
  const hits = [];
  if (/^s_[0-9a-f]{4,32}$/.test(q)) {
    location.hash = `#/session/${q}`;
    return [];
  }
  if (/^\d+$/.test(q) && network.posts.some((p) => p.index === Number(q))) hits.push([`Bulletin post #${q}`, `#/post/${q}`]);
  const ver = q.replace(/^v/i, "");
  if (appRelease(ver)) hits.push([`PAC app ${ver}`, `#/app/${ver}`]);
  if (/^[0-9a-f]{6,64}$/.test(lower)) {
    for (const t of network.tees) if (t.id.startsWith(lower)) hits.push([`TEE ${short(t.id, 12)}`, `#/tee/${t.id}`]);
    for (const p of network.profiles) if (p.id.startsWith(lower)) hits.push([`Person: ${p.name}`, `#/person/${p.id}`]);
    for (const r of network.deployment.releases) if (r.measurement.startsWith(lower) || (r.commit ?? "").startsWith(lower)) hits.push([`Release ${r.version ?? short(r.measurement, 10)}`, `#/release/${r.measurement}`]);
    for (const p of network.programs) if (p.sha256.startsWith(lower)) hits.push([`Program ${p.name} @${short(p.sha256, 10)}`, `#/program/${p.sha256}`]);
  }
  for (const p of network.profiles) if (lower.length >= 2 && p.name.toLowerCase().includes(lower) && !hits.some((x) => x[1] === `#/person/${p.id}`)) hits.push([`Person: ${p.name}`, `#/person/${p.id}`]);
  for (const r of network.deployment.releases) if (lower.length >= 2 && (r.codeIdentity.toLowerCase().includes(lower) || (r.version ?? "") === q)) hits.push([`Release ${r.version ?? ""} · ${short(r.codeIdentity, 18)}`, `#/release/${r.measurement}`]);
  const yours = await loadMine();
  for (const x of yours ?? []) for (const t of x.turns ?? []) if (lower.length >= 3 && t.prompt.toLowerCase().includes(lower) && !hits.some((y) => y[1] === `#/session/${x.id}`)) hits.push([`Your session: ${short(t.prompt, 70)}`, `#/session/${x.id}`]);
  if (hits.length === 1) {
    location.hash = hits[0][1];
    return [];
  }
  return [h("h1", {}, "Search"), h("p", { class: "lede" }, `${hits.length} result${hits.length === 1 ? "" : "s"} for “`, q, "”"), hits.length ? h("ul", {}, hits.map(([label, href]) => h("li", {}, h("a", { href }, label)))) : h("p", { class: "empty" }, mode.private ? "Nothing matches. Try a session id, a hash prefix, a name or a version." : "Nothing public matches. A session id opens only in your own local explorer.")];
}

// ---- Routing ---------------------------------------------------------------

const ROUTES = [
  [/^\/?$/, overview, "#/"],
  [/^\/tees$/, teesPage, "#/tees"],
  [/^\/tee\/([0-9a-f]{64})$/, teePage, "#/tees"],
  [/^\/releases$/, releasesPage, "#/releases"],
  [/^\/release\/([0-9a-f]{64})$/, releasePage, "#/releases"],
  [/^\/app\/(\d+\.\d+\.\d+)$/, appPage, "#/releases"],
  [/^\/programs$/, programsPage, "#/programs"],
  [/^\/program\/([0-9a-f]{64})$/, programPage, "#/programs"],
  [/^\/people$/, peoplePage, "#/people"],
  [/^\/person\/([0-9a-f]{64})$/, personPage, "#/people"],
  [/^\/bulletin$/, bulletinPage, "#/bulletin"],
  [/^\/post\/(\d+)$/, postPage, "#/bulletin"],
  [/^\/sessions$/, sessionsPage, "#/sessions"],
  [/^\/session\/(s_[0-9a-f]{4,32})$/, sessionPage, "#/sessions"],
  [/^\/search\/(.+)$/, searchPage, ""],
];
const TABS = [["#/", "Network"], ["#/tees", "TEEs"], ["#/releases", "Releases"], ["#/programs", "Programs"], ["#/people", "People"], ["#/bulletin", "Bulletin"], ["#/sessions", "Your sessions"]];

function drawTabs(active) {
  tabs.replaceChildren(...TABS.map(([href, label]) => h("a", { href, class: href === "#/sessions" && mode.private ? "private" : "", "aria-current": href === active ? "page" : false }, label)));
}

let routing = 0;

async function route() {
  const ticket = ++routing;
  const path = location.hash.replace(/^#/, "") || "/";
  const found = ROUTES.map(([re, page, tab]) => [path.match(re), page, tab]).find(([m]) => m);
  const [m, page, tab] = found ?? [[], () => [h("h1", {}, "Not found"), h("p", {}, h("a", { href: "#/" }, "Back to the network"))], ""];
  drawTabs(tab);
  try {
    const nodes = await page(...m.slice(1));
    // A newer route started while this one waited: it draws, not this one.
    if (ticket !== routing || !nodes.length) return;
    main.replaceChildren(h("div", { class: "reveal" }, nodes));
  } catch (e) {
    main.replaceChildren(h("h1", {}, "Couldn't show this"), h("p", { class: "warn" }, String(e.message ?? e)));
  }
  window.scrollTo(0, 0);
}

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
});
window.addEventListener("hashchange", route);

async function boot() {
  try {
    const networkLoad = api("/api/network");
    mode = await api("/api/mode");
    void loadMine();
    network = await networkLoad;
  } catch {
    main.replaceChildren(h("h1", {}, "PAC's network didn't answer"), h("p", { class: "lede" }, "The descriptor, bulletin or vault couldn't be read just now. Try again in a minute."));
    return;
  }
  if (mode.private) {
    meInfo = await api("/api/me").catch(() => undefined);
    modeEl.replaceChildren(h("i"), `local · ${meInfo?.name ?? "you"}${meInfo?.version ? ` · pac ${meInfo.version}` : ""}`);
    modeEl.className = "mode";
  } else {
    modeEl.replaceChildren(h("i"), mode.mode === "local" ? "local · open the printed link to see your sessions" : "public network");
    modeEl.className = "mode public";
  }
  await route();
}
boot();
