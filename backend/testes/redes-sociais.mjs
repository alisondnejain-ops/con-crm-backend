/* REDES SOCIAIS (20/10/2026) — publicar e programar posts no Facebook e no
   Instagram, ler o engajamento, e a automação de comentários estilo ManyChat.

   Servidor de pé e uma Meta de mentira (META_GRAPH_URL): o que importa é a
   porta (só gestor, só com o Marketing, cada conta vê o que é dela), o que o
   ConHub manda para a Meta em cada formato, e que nada sai antes da hora.
   O agendador é chamado direto com o relógio na mão (REDES_AGENDADOR=0).

   Rodar:  npm run teste:redes-sociais
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-redes-sociais.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
const PORTA = 4831, PORTA_META = 4832, SEGREDO = "segredo-do-app";
process.env.DB_PATH = DB;
process.env.META_GRAPH_URL = `http://127.0.0.1:${PORTA_META}`;
process.env.CRYPTO_KEY = "b".repeat(64);

/* ===== A Meta de mentira ===== */
const chamadas = [];           // { metodo, caminho, params }
let seq = 0;
const containers = {};         // id -> { status sequence }
const TODAS = ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "pages_manage_posts",
  "read_insights", "pages_manage_engagement", "pages_messaging", "pages_read_user_content", "instagram_basic",
  "instagram_content_publish", "instagram_manage_insights", "instagram_manage_comments", "instagram_manage_messages"];
let concedidas = TODAS;
const tokenDaPagina = (pg) => "tokpage-" + pg;
const meta = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let corpo = "";
  for await (const pedaco of req) corpo += pedaco;
  const params = { ...Object.fromEntries(u.searchParams), ...Object.fromEntries(new URLSearchParams(corpo)) };
  const tok = params.access_token;
  const ok = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const erro = (m, code = 100, sub) => { res.statusCode = 400; ok({ error: { message: m, code, error_subcode: sub } }); };
  const p = u.pathname.replace(/^\/v[\d.]+\//, "");
  if (req.method === "POST") chamadas.push({ caminho: p, params });
  if (p === "oauth/access_token") return ok({ access_token: params.fb_exchange_token ? "longo" : "curto" });
  if (p === "me/accounts") return ok({ data: ["P1", "P2"].map((id) => ({ id, name: "Página " + id, access_token: tokenDaPagina(id) })) });
  if (p === "me/permissions") return ok({ data: concedidas.map(permission => ({ permission, status: "granted" })) });
  const sub = p.match(/^(\w+)\/subscribed_apps$/);
  if (sub) {
    if (sub[1] === "P2" && String(params.subscribed_fields).includes("feed")) return erro("(#200) feed exige permissão", 200);
    return ok({ success: true });
  }
  if (req.method === "GET" && (p === "P1" || p === "P2")) {
    const f = params.fields || "";
    if (f.includes("instagram_business_account"))
      return ok(p === "P1" ? { instagram_business_account: { id: "IG1", username: "casa_a", followers_count: 120 } } : {});
    return ok({ name: "Página " + p, followers_count: 500, picture: { data: { url: "https://x/p.jpg" } } });
  }
  if (tok !== tokenDaPagina("P1") && tok !== tokenDaPagina("P2")) return erro("token inválido", 190);
  // Facebook
  if (p === "P1/feed" && req.method === "POST") return ok({ id: "P1_post" + (++seq) });
  if (p === "P1/photos") return ok(params.published === "false" ? { id: "ph" + (++seq) } : { id: "ph" + (++seq), post_id: "P1_foto" + seq });
  if (p === "P1/videos") return ok({ id: "vid" + (++seq) });
  if (p === "P1/published_posts") return ok({ data: [
    { id: "P1_foto1", message: "Casa nova", created_time: new Date().toISOString(), permalink_url: "https://fb/1",
      reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } },
    { id: "P1_antigo", message: "Post de fora", created_time: new Date(Date.now() - 5 * 86400000).toISOString(),
      reactions: { summary: { total_count: 4 } }, comments: { summary: { total_count: 0 } } },
  ] });
  // Instagram
  if (p === "IG1/media" && req.method === "POST") {
    const id = "ctn" + (++seq);
    containers[id] = params.caption === "FALHA" ? ["ERROR"] : params.media_type === "REELS" ? ["IN_PROGRESS", "FINISHED"] : ["FINISHED"];
    return ok({ id });
  }
  if (p === "IG1/media_publish") return ok({ id: "igm" + (++seq) });
  if (p === "IG1" && req.method === "GET") return ok({ username: "casa_a", followers_count: 130, media_count: 8 });
  if (p === "IG1/media" && req.method === "GET") return ok({ data: [
    { id: "igm_x", caption: "Reels da casa", media_type: "VIDEO", media_product_type: "REELS", timestamp: new Date().toISOString(),
      permalink: "https://ig/x", like_count: 40, comments_count: 5 },
  ] });
  if (/^igm_x\/insights$/.test(p)) {
    if (String(params.metric).includes(",")) return erro("(#100) metric views not supported");   // força pedir uma a uma
    const v = { reach: 900, saved: 12, shares: 7 }[params.metric];
    return v == null ? erro("métrica aposentada") : ok({ data: [{ name: params.metric, values: [{ value: v }] }] });
  }
  if (containers[p] && req.method === "GET") {
    const st = containers[p].length > 1 ? containers[p].shift() : containers[p][0];
    return ok({ status_code: st, status: st === "ERROR" ? "Error: Media download has failed" : st });
  }
  if (/^(igm|P1_)\w*$/.test(p) && req.method === "GET") return ok({ permalink: "https://ig/" + p, permalink_url: "https://fb/" + p });
  // Comentários
  if (/^\w+\/(comments|replies)$/.test(p) || p === "P1/messages") return ok({ id: "r" + (++seq) });
  erro("não existe: " + req.method + " " + p);
});
await new Promise((r) => meta.listen(PORTA_META, "127.0.0.1", r));

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: `http://127.0.0.1:${PORTA}`,
    META_APP_ID: "app1", META_APP_SECRET: SEGREDO, META_PERMISSOES_REDES: "1", REDES_AGENDADOR: "0", MARKETING_AGENDADOR: "0", UAZAPI_AUTOCONFIGURAR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const posts = (p) => chamadas.filter(c => c.caminho === p);

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await espera(250);
  }
  const { default: db } = await import("../src/db.js");
  const { processarRedes } = await import("../src/services/redes.js");
  const { randomUUID } = await import("crypto");
  const sharp = (await import("sharp")).default;
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const orgA = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Casa B", "CASA-B", Date.now() + 1000);
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(orgA, "gestora@redes.com", "adm");
  usuario(orgA, "sdr@redes.com", "sdr");
  usuario(orgA, "corretora@redes.com", "corretor");
  usuario(orgB, "gestorb@redes.com", "adm");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const ir = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { get: (p) => ir("GET", p), post: (p, b) => ir("POST", p, b || {}), put: (p, b) => ir("PUT", p, b || {}), del: (p) => ir("DELETE", p) };
  };
  const A = await como("gestora@redes.com"), B = await como("gestorb@redes.com");
  const sdr = await como("sdr@redes.com"), corretor = await como("corretora@redes.com");
  const liberar = (o, sim = true) => db.prepare(`INSERT INTO org_recursos (org_id, recurso, master, master_em) VALUES (?, 'marketing', ?, ?)
    ON CONFLICT(org_id, recurso) DO UPDATE SET master = excluded.master`).run(o, sim ? "liberado" : "retirado", Date.now());
  const conectar = async (quem, paginas) => {
    const ini = await quem.post("/anuncios-meta/iniciar");
    const state = new URL(ini.body.url).searchParams.get("state");
    const r = await fetch(url("/conectar-facebook/retorno?" + new URLSearchParams({ code: "bom", state })), { redirect: "manual" });
    const k = new URL(r.headers.get("location")).searchParams.get("k");
    return quem.post(`/anuncios-meta/escolha/${k}`, { page_ids: paginas });
  };

  caso("Sem o Marketing liberado, as redes sociais não abrem");
  assert.equal((await A.get("/redes")).status, 403);

  caso("O botão de conectar pede as permissões das redes sociais (e continua pedindo a de anúncios)");
  liberar(orgA); liberar(orgB);
  const ini = await A.post("/anuncios-meta/iniciar");
  const escopo = new URL(ini.body.url).searchParams.get("scope");
  for (const p of ["ads_read", "leads_retrieval", "pages_manage_posts", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_messages"])
    assert.ok(escopo.includes(p), p);

  caso("Conectar a página traz o Instagram ligado, as permissões concedidas e liga os avisos de comentários");
  let r = await conectar(A, ["P1"]);
  assert.ok(r.body.resultado[0].ok, JSON.stringify(r.body));
  const pag = db.prepare("SELECT * FROM meta_paginas WHERE page_id = 'P1'").get();
  assert.equal(pag.ig_id, "IG1");
  assert.equal(pag.ig_usuario, "casa_a");
  assert.ok(pag.permissoes.includes("instagram_content_publish"));
  assert.equal(pag.avisos_campos, "leadgen,feed");
  r = await A.get("/redes");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paginas[0].instagram.usuario, "casa_a");
  assert.deepEqual(r.body.paginas[0].faltam.publicar_instagram, []);
  assert.equal(r.body.paginas[0].comentarios_ligados, true);

  caso("Se a Meta recusar os avisos de comentários, a página conecta mesmo assim (o lead não pode depender disso)");
  r = await conectar(B, ["P2"]);
  assert.ok(r.body.resultado[0].ok, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT avisos_campos FROM meta_paginas WHERE page_id = 'P2'").get().avisos_campos, "leadgen");

  caso("Atendente e corretor não entram; a outra conta não vê a página desta");
  assert.equal((await sdr.get("/redes")).status, 403);
  assert.equal((await corretor.get("/redes")).status, 403);
  assert.equal((await B.post("/redes/posts", { page_id: "P1", redes: ["facebook"], texto: "invasão" })).status, 404);
  assert.equal((await B.get("/redes/engajamento/P1")).status, 404);

  caso("A foto enviada vira JPEG de até 1440 px, com as medidas");
  const png = await sharp({ create: { width: 2000, height: 2500, channels: 3, background: "#3a7" } }).png().toBuffer();
  r = await A.post("/redes/midias", { base64: png.toString("base64"), mime: "image/png" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.largura, 1440); assert.equal(r.body.altura, 1800);
  const foto = r.body;
  const bytes = Buffer.from(await (await fetch(foto.url)).arrayBuffer());
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);   // JPEG

  caso("As regras de cada rede são conferidas antes de programar");
  const foto2 = { url: "https://cdn/x2.jpg", tipo: "foto", largura: 1080, altura: 1080 };
  const video = { url: "https://cdn/v.mp4", tipo: "video" };
  const recusa = async (dados, trecho) => {
    const x = await A.post("/redes/posts", { page_id: "P1", ...dados });
    assert.equal(x.status >= 400, true, JSON.stringify(x.body));
    assert.match(x.body.error, trecho);
  };
  await recusa({ redes: ["instagram"], texto: "só texto" }, /não aceita post só de texto/);
  await recusa({ redes: ["facebook", "instagram"], formato: "story", midias: [foto] }, /Story só pode/);
  await recusa({ redes: ["instagram"], midias: [{ url: "https://cdn/alta.jpg", tipo: "foto", largura: 1000, altura: 2000 }] }, /em pé demais/);
  await recusa({ redes: ["facebook"], midias: [foto, video] }, /só aceita fotos/);
  await recusa({ redes: ["instagram"], midias: [foto], texto: "x".repeat(2201) }, /2200/);
  await recusa({ redes: ["facebook"], texto: "ontem", agendar_para: Date.now() - 3600000 }, /já passou/);
  await recusa({ redes: [], texto: "a" }, /Escolha onde publicar/);

  caso("Post programado não sai antes da hora; na hora, o Facebook publica e o Instagram faz os dois passos");
  const daqui1h = Date.now() + 3600000;
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["facebook", "instagram"], texto: "Casa nova no Centro 🏡", midias: [foto], agendar_para: daqui1h });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p1 = r.body.id;
  assert.equal(r.body.status, "agendado");
  assert.equal(await processarRedes(Date.now()), 0, "nada antes da hora");
  await processarRedes(daqui1h + 1000);
  assert.equal(posts("P1/photos").at(-1).params.url, foto.url);
  assert.equal(posts("P1/photos").at(-1).params.message, "Casa nova no Centro 🏡");
  assert.equal(posts("IG1/media").at(-1).params.image_url, foto.url);
  await processarRedes(daqui1h + 10000);
  assert.equal(posts("IG1/media_publish").length, 1);
  r = await A.get("/redes/posts");
  const pub = r.body.posts.find(x => x.id === p1);
  assert.equal(pub.status, "publicado");
  assert.ok(pub.destinos.every(d => d.status === "publicado" && d.link), JSON.stringify(pub.destinos));

  caso("Carrossel: no Facebook vai como uma postagem com as fotos anexadas; no Instagram, um item por foto e depois o carrossel");
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["facebook", "instagram"], texto: "Duas fotos", midias: [foto, foto2] });
  const p2 = r.body.id;
  const antesFotos = posts("P1/photos").length;
  await processarRedes(Date.now() + 1000);
  assert.equal(posts("P1/photos").length - antesFotos, 2);
  assert.ok(posts("P1/photos").slice(-2).every(c => c.params.published === "false"));
  const feed = posts("P1/feed").at(-1).params;
  assert.ok(feed["attached_media[0]"] && feed["attached_media[1]"], JSON.stringify(feed));
  assert.equal(posts("IG1/media").slice(-2).every(c => c.params.is_carousel_item === "true"), true);
  await processarRedes(Date.now() + 20000);
  const carrossel = posts("IG1/media").at(-1).params;
  assert.equal(carrossel.media_type, "CAROUSEL");
  assert.equal(carrossel.children.split(",").length, 2);
  await processarRedes(Date.now() + 40000);
  assert.equal((await A.get("/redes/posts")).body.posts.find(x => x.id === p2).status, "publicado");

  caso("Reels: o Instagram processa o vídeo (espera e confere) e só publica quando fica pronto");
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["facebook", "instagram"], formato: "reels", texto: "Tour", midias: [video] });
  const p3 = r.body.id;
  const pubAntes = posts("IG1/media_publish").length;
  await processarRedes(Date.now() + 1000);
  assert.equal(posts("P1/videos").at(-1).params.file_url, video.url);
  assert.equal(posts("IG1/media").at(-1).params.media_type, "REELS");
  await processarRedes(Date.now() + 20000);           // ainda processando
  assert.equal(posts("IG1/media_publish").length, pubAntes);
  await processarRedes(Date.now() + 40000);           // pronto
  assert.equal(posts("IG1/media_publish").length, pubAntes + 1);
  assert.equal((await A.get("/redes/posts")).body.posts.find(x => x.id === p3).status, "publicado");

  caso("Story vai só para o Instagram");
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["instagram"], formato: "story", midias: [foto] });
  await processarRedes(Date.now() + 1000);
  assert.equal(posts("IG1/media").at(-1).params.media_type, "STORIES");

  caso("O Instagram recusou a mídia: a falha fica escrita, e o Facebook que deu certo continua publicado");
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["facebook", "instagram"], texto: "FALHA", midias: [foto] });
  const p5 = r.body.id;
  await processarRedes(Date.now() + 1000);
  await processarRedes(Date.now() + 20000);
  const p5d = (await A.get("/redes/posts")).body.posts.find(x => x.id === p5);
  assert.equal(p5d.status, "parcial");
  assert.match(p5d.destinos.find(d => d.rede === "instagram").erro, /processar a mídia/);

  caso("Editar e cancelar antes da hora; o cancelado não sai");
  r = await A.post("/redes/posts", { page_id: "P1", redes: ["facebook"], texto: "Rascunho", agendar_para: daqui1h });
  const p6 = r.body.id;
  r = await A.put(`/redes/posts/${p6}`, { redes: ["facebook"], texto: "Texto corrigido", agendar_para: daqui1h });
  assert.equal(r.body.texto, "Texto corrigido");
  r = await A.post(`/redes/posts/${p6}/cancelar`);
  assert.equal(r.body.status, "cancelado");
  const feedAntes = posts("P1/feed").length;
  await processarRedes(daqui1h + 5000);
  assert.equal(posts("P1/feed").length, feedAntes);
  assert.equal((await A.put(`/redes/posts/${p1}`, { redes: ["facebook"], texto: "x" })).status, 409, "publicado não se edita");
  assert.equal((await A.del(`/redes/posts/${p6}`)).status, 200);

  caso("Sem a permissão de publicar no Instagram, programar diz o que falta");
  db.prepare("UPDATE meta_paginas SET permissoes = ? WHERE page_id = 'P1'").run(TODAS.filter(x => x !== "instagram_content_publish").join(","));
  await recusa({ redes: ["instagram"], midias: [foto] }, /instagram_content_publish/);
  db.prepare("UPDATE meta_paginas SET permissoes = ? WHERE page_id = 'P1'").run(TODAS.join(","));

  caso("Engajamento: seguidores, posts das duas redes (inclusive os de fora do ConHub) e as métricas que a Meta deu");
  r = await A.get("/redes/engajamento/P1?atualizar=1");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ig = r.body.contas.find(c => c.rede === "instagram"), fb = r.body.contas.find(c => c.rede === "facebook");
  assert.equal(ig.seguidores, 130); assert.equal(fb.seguidores, 500);
  const reels = r.body.posts.find(x => x.id === "igm_x");
  assert.equal(reels.alcance, 900); assert.equal(reels.salvos, 12); assert.equal(reels.compartilhamentos, 7);
  assert.equal(reels.visualizacoes, null, "métrica que a Meta recusou fica vazia, não zero");
  assert.equal(r.body.posts.find(x => x.id === "P1_foto1").do_conhub, true);
  assert.equal(r.body.posts.find(x => x.id === "P1_antigo").do_conhub, false);
  assert.equal(r.body.resumo.facebook.curtidas, 14);
  assert.equal(r.body.resumo.instagram.interacoes, 40 + 5 + 7 + 12);
  assert.equal((await A.get("/redes/engajamento/P1")).body.do_cache, true);

  caso("Automação de comentários: só gestor cria; precisa de resposta e de palavra válida");
  db.prepare("INSERT INTO sites (org_id, slug, ligado, whatsapp, created_at) VALUES (?, 'casa-a', 0, '(87) 99999-0000', ?)").run(orgA, Date.now());
  assert.equal((await corretor.post("/redes/automacoes", {})).status, 403);
  assert.equal((await A.post("/redes/automacoes", { page_id: "P1", nome: "x", redes: ["instagram"] })).status, 400);
  r = await A.post("/redes/automacoes", { page_id: "P1", nome: "Lançamento", redes: ["instagram", "facebook"], palavras: ["quero", "valor"],
    respostas: ["Te chamei no direct, {nome}! 📩"], mensagem_privada: "Oi {nome}! Fala com a gente no WhatsApp: {whatsapp}" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const regra = r.body.id;
  assert.deepEqual(r.body.faltam_permissoes, []);

  const avisar = async (corpo) => {
    const txt = JSON.stringify(corpo);
    const sig = "sha256=" + crypto.createHmac("sha256", SEGREDO).update(txt).digest("hex");
    const x = await fetch(url("/webhooks/meta"), { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: txt });
    await espera(400);
    return x.status;
  };
  const igComentario = (id, texto, de = { id: "u1", username: "ana_x" }, media = "igm_x") =>
    ({ object: "instagram", entry: [{ id: "IG1", time: 1, changes: [{ field: "comments", value: { id, text: texto, from: de, media: { id: media } } }] }] });

  caso("Comentou a palavra no Instagram: resposta pública no comentário e mensagem no privado com o link do WhatsApp");
  assert.equal(await avisar(igComentario("IGC1", "Eu QUERO saber o Valor!")), 200);
  assert.equal(posts("IGC1/replies").length, 1);
  assert.equal(posts("IGC1/replies")[0].params.message, "Te chamei no direct, ana_x! 📩");
  const dm = posts("P1/messages").at(-1).params;
  assert.equal(JSON.parse(dm.recipient).comment_id, "IGC1");
  assert.match(JSON.parse(dm.message).text, /https:\/\/wa\.me\/5587999990000/);

  caso("O mesmo comentário avisado de novo não responde duas vezes");
  await avisar(igComentario("IGC1", "Eu QUERO saber o Valor!"));
  assert.equal(posts("IGC1/replies").length, 1);

  caso("Sem a palavra, comentário da própria conta, ou palavra dentro de outra (valorizou) — nada acontece");
  await avisar(igComentario("IGC2", "Que lindo!"));
  await avisar(igComentario("IGC3", "quero", { id: "IG1", username: "casa_a" }));
  await avisar(igComentario("IGC4", "isso valorizou demais"));
  assert.equal(posts("IGC2/replies").length + posts("IGC3/replies").length + posts("IGC4/replies").length, 0);

  caso("Comentário no Facebook (campo feed) também é respondido, com o primeiro nome");
  await avisar({ object: "page", entry: [{ id: "P1", time: 1, changes: [{ field: "feed",
    value: { item: "comment", verb: "add", comment_id: "FBC1", post_id: "P1_foto1", message: "valor?", from: { id: "u9", name: "Bruno Lima" } } }] }] });
  assert.equal(posts("FBC1/comments")[0].params.message, "Te chamei no direct, Bruno! 📩");

  caso("Automação presa a um post: comentário em outro post não dispara");
  await A.put(`/redes/automacoes/${regra}`, { page_id: "P1", nome: "Lançamento", redes: ["instagram"], palavras: ["quero"],
    respostas: ["ok"], posts: [{ id: "igm_x", rede: "instagram" }] });
  await avisar(igComentario("IGC5", "quero", undefined, "outro_post"));
  assert.equal(posts("IGC5/replies").length, 0);
  await avisar(igComentario("IGC6", "quero", undefined, "igm_x"));
  assert.equal(posts("IGC6/replies").length, 1);

  caso("Os números da automação contam o que foi respondido");
  r = await A.get("/redes/automacoes");
  const nums = r.body.regras.find(x => x.id === regra).numeros;
  assert.equal(nums.total, 3); assert.equal(nums.publicas, 3); assert.equal(nums.privadas, 2);

  caso("Desligada, ou com o Marketing retirado, a automação não responde");
  await A.put(`/redes/automacoes/${regra}`, { ativo: false });
  await avisar(igComentario("IGC7", "quero"));
  assert.equal(posts("IGC7/replies").length, 0);
  await A.put(`/redes/automacoes/${regra}`, { ativo: true });
  liberar(orgA, false);
  await avisar(igComentario("IGC8", "quero"));
  assert.equal(posts("IGC8/replies").length, 0);

  caso("Marketing retirado: o post programado não sai, e a falha diz por quê");
  db.prepare("INSERT INTO redes_posts (id,org_id,page_id,formato,texto,midias_json,redes_json,agendar_para,status,criado_em) VALUES ('rp_x',?, 'P1','post','x','[]','[\"facebook\"]',?, 'agendado', ?)")
    .run(orgA, Date.now(), Date.now());
  db.prepare("INSERT INTO redes_destinos (id,post_id,org_id,rede,status,proxima_em) VALUES ('rd_x','rp_x',?,'facebook','pendente',?)").run(orgA, Date.now());
  await processarRedes(Date.now() + 1000);
  assert.match(db.prepare("SELECT erro FROM redes_destinos WHERE id = 'rd_x'").get().erro, /Marketing/);

  console.log("\nTudo certo.");
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(e.stack?.split("\n").slice(1, 4).join("\n"));
  console.error(saida.slice(-3000));
  process.exitCode = 1;
} finally {
  servidor.kill();
  meta.close();
}
