/* CETROLAB — MODELO INSTITUCIONAL (12/10/2026).

   A estrutura do site da Invix (pedido do Ali) com o conteúdo de cada
   imobiliária. O que o teste prova, lendo o HTML como o visitante lê:
     1. o conteúdo institucional se cadastra, e o que é perigoso é recusado
        (rede social de outro site, http, pessoa de outra conta, depoimento sem nome);
     2. a prévia mostra a casa inteira: capa com os imóveis, contagem real,
        destaques, lançamentos (empreendimentos), para alugar, sobre nós,
        depoimentos e equipe — e de quem é da equipe não vaza e-mail nem telefone;
     3. quem não foi escolhido não aparece, e quem sai da equipe some sozinho;
     4. sem conteúdo, as seções não aparecem (nada inventado);
     5. a busca, o "buscar por código" e a lista de lançamentos;
     6. nada interno do imóvel vaza, e texto da equipe sai escapado;
     7. com o Cetrolab, o site vai ao ar no Institucional, inclusive a página do imóvel.

   Rodar:  npm run teste:cetrolab-institucional
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-cetrolab-inst.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4763;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "INST-1", APP_URL: "", FOTOS_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await new Promise((x) => setTimeout(x, 250));
  }
  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const org = db.prepare("SELECT id FROM orgs WHERE adm_code = 'INST-1'").get().id;
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run("Rota Imóveis", org);
  const outra = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(outra, "Outra Casa", "OUT-1", Date.now());
  const usuario = (nome, email, role, master = 0, o = org, phone = null) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master,phone) VALUES (?,?,?,?,?,?,1,?,'ativo',?,?)`)
      .run(id, o, nome, email, senha, role, Date.now(), master, phone);
    return id;
  };
  usuario("Gestora Rota", "gestor@inst.com", "adm");
  usuario("Master", "master@inst.com", "adm", 1);
  const marina = usuario("Marina Lopes", "marina.segredo@inst.com", "corretor", 0, org, "5587999990001");
  const bruno = usuario("Bruno <b>Dias</b>", "bruno@inst.com", "corretor");
  const naoEscolhido = usuario("Carla Fora", "carla@inst.com", "corretor");
  const deOutra = usuario("Estranho", "x@out.com", "corretor", 0, outra);
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run("/arquivos/avatares/marina.jpg", marina);

  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    return {
      get: async (p) => { const r = await fetch(url(p), { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
      send: async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };
  const gestor = await como("gestor@inst.com");
  const master = await como("master@inst.com");
  const pagina = async (p) => { const r = await fetch(url(p)); return { status: r.status, html: await r.text() }; };
  const imovel = (dados) => {
    const id = "p_" + randomUUID();
    db.prepare(`INSERT INTO produtos (id,org_id,tipo,formato,finalidade,titulo,cidade,bairro,valor,quartos,construtor,comissao_pct,observacoes,captador_nome,status,created_by,created_at)
      VALUES (@id,@org,'casa',@formato,@finalidade,@titulo,'Petrolina',@bairro,@valor,3,'Construtora Segredo',6,'dono aceita 10% abaixo','Captador Interno','ativo','x',@agora)`)
      .run({ id, org, agora: Date.now(), finalidade: "venda", formato: "solta", ...dados });
    db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,0,?)")
      .run("m_" + randomUUID(), id, "foto", `/arquivos/produtos/${id}.jpg`, Date.now());
    return id;
  };
  const casa = imovel({ titulo: "Casa com piscina no Centro", bairro: "Centro", valor: 410000 });
  imovel({ titulo: "Residencial Horizonte", bairro: "Orla", valor: 520000, formato: "empreendimento" });
  imovel({ titulo: "Apartamento para alugar na Orla", bairro: "Orla", valor: 1900, finalidade: "aluguel" });
  imovel({ titulo: "Casa <script>alert(1)</script> nova", bairro: "Areia Branca", valor: 300000 });
  await gestor.send("PATCH", "/site", { ligado: true, whatsapp: "(87) 99999-0000" });
  const slug = (await gestor.get("/site")).body.slug;

  caso("O Institucional aparece em segundo e pede o Cetrolab");
  const s = (await gestor.get("/site")).body;
  assert.deepEqual(s.modelos.map(m => m.id), ["bairros", "institucional", "editorial", "lancamento", "classico"]);
  assert.equal((await gestor.send("POST", "/site/modelo", { modelo: "institucional" })).status, 402);

  caso("Sem conteúdo cadastrado, as seções institucionais não aparecem");
  let p = await pagina(`/imoveis/${slug}?previa=institucional`);
  assert.equal(p.status, 200);
  for (const t of ["Sobre nós</h2>", "O que falam de nós", "Nossa equipe"]) assert.ok(!p.html.includes(t), `não pode aparecer: ${t}`);
  assert.ok(p.html.includes("São 4 imóveis disponíveis à sua espera!"), "a contagem é a do catálogo");

  caso("O que é perigoso no conteúdo é recusado");
  const recusa = async (b, trecho) => {
    const r = await gestor.send("PATCH", "/site/conteudo", b);
    console.log(`   ${r.status} · ${r.body.error}`);
    assert.equal(r.status, 400); assert.ok(r.body.error.includes(trecho), r.body.error);
  };
  await recusa({ instagram: "https://golpe.com/instagram.com" }, "não é um endereço do Instagram");
  await recusa({ facebook: "http://facebook.com/rota" }, "https://");
  await recusa({ equipe: [deOutra] }, "ativo na equipe desta conta");
  await recusa({ depoimentos: [{ nome: "", texto: "Atendimento excelente do começo ao fim." }] }, "sem o nome");
  await recusa({ sobre: "x".repeat(1501) }, "1500");

  caso("Conteúdo de verdade é salvo");
  let r = await gestor.send("PATCH", "/site/conteudo", {
    sobre: "Há 12 anos ajudando famílias de Petrolina a encontrar o lugar certo.",
    instagram: "https://www.instagram.com/rotaimoveis", youtube: "https://youtube.com/@rota",
    equipe: [marina, bruno],
    depoimentos: [{ nome: "Raphaela Brito", texto: "Me senti acolhida do começo ao fim da venda." }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.equipe, [marina, bruno]);
  assert.ok(r.body.pessoas.some(x => x.id === naoEscolhido), "a lista de quem pode ser escolhido vem junto");
  assert.ok(!r.body.pessoas.some(x => x.nome === "Master"), "o master do ConHub não é da equipe da imobiliária");

  caso("A prévia mostra a casa inteira, na estrutura do site de referência");
  p = await pagina(`/imoveis/${slug}?previa=institucional`);
  const tem = (t, msg) => assert.ok(p.html.includes(t), msg || `faltou: ${t}`);
  tem('id="slides"', "a capa em carrossel");
  tem("Mais detalhes"); tem("Buscar por código");
  tem("Imóveis em destaque"); tem("Lançamentos"); tem("Residencial Horizonte"); tem("Para alugar");
  tem("Há 12 anos ajudando famílias"); tem("Raphaela Brito"); tem("Nossa equipe"); tem("Marina Lopes");
  tem("/arquivos/avatares/marina.jpg", "a foto de Minha conta");
  tem("Quer vender ou alugar seu imóvel?");
  tem("https://www.instagram.com/rotaimoveis");
  tem("noindex", "prévia não entra no Google");
  const lanc = p.html.slice(p.html.indexOf("Lançamentos</h2>"), p.html.indexOf("Para alugar</h2>"));
  assert.ok(lanc.includes("Residencial Horizonte") && !lanc.includes("Casa com piscina"), "lançamento é só empreendimento");

  caso("Da equipe sai nome, foto e função — nunca e-mail nem telefone; quem não foi escolhido não aparece");
  assert.ok(!p.html.includes("marina.segredo@inst.com") && !p.html.includes("5587999990001"));
  assert.ok(!p.html.includes("Carla Fora"));
  assert.ok(p.html.includes("Bruno &lt;b&gt;Dias&lt;/b&gt;") && !p.html.includes("Bruno <b>"), "nome escapado");
  db.prepare("UPDATE users SET status = 'removido' WHERE id = ?").run(bruno);
  p = await pagina(`/imoveis/${slug}?previa=institucional`);
  assert.ok(!p.html.includes("Bruno"), "quem sai da equipe some do site sozinho");

  caso("Nada interno do imóvel vaza, e título com código sai escapado");
  for (const segredo of ["Construtora Segredo", "dono aceita", "Captador Interno"]) assert.ok(!p.html.includes(segredo), segredo);
  assert.ok(!p.html.includes("<script>alert(1)</script>"));

  caso("A busca, o código e a lista de lançamentos");
  p = await pagina(`/imoveis/${slug}?previa=institucional&busca=1&finalidade=aluguel`);
  assert.ok(p.html.includes("Apartamento para alugar na Orla") && !p.html.includes("Casa com piscina no Centro"));
  assert.ok(p.html.includes("1 imóvel encontrado"));
  const codigo = casa.replace(/^p_/, "").replace(/-/g, "").slice(0, 6).toUpperCase();
  p = await pagina(`/imoveis/${slug}?previa=institucional&codigo=${codigo.toLowerCase()}`);
  assert.ok(p.html.includes("Casa com piscina no Centro") && p.html.includes("1 imóvel encontrado"), "o código acha o imóvel");
  p = await pagina(`/imoveis/${slug}?previa=institucional&lancamentos=1`);
  assert.ok(p.html.includes("Residencial Horizonte") && p.html.includes("1 imóvel encontrado"));
  p = await pagina(`/imoveis/${slug}?previa=institucional&codigo=ZZZZZZ`);
  assert.ok(!p.html.includes("imóvel encontrado") || p.html.includes("4 imóveis"), "código inválido não vira filtro");

  caso("Com o Cetrolab, o site vai ao ar no Institucional — e a página do imóvel também");
  assert.equal((await master.send("POST", `/orgs/${org}/recursos/cetrolab`, { estado: "liberado" })).status, 200);
  r = await gestor.send("POST", "/site/modelo", { modelo: "institucional" });
  assert.equal(r.status, 200); assert.equal(r.body.modelo_no_ar, "institucional");
  p = await pagina(`/imoveis/${slug}`);
  assert.ok(p.html.includes('id="slides"') && !p.html.includes("PRÉVIA DO MODELO"));
  const im = await pagina(`/imoveis/${slug}/${casa}/casa-com-piscina-no-centro`);
  assert.equal(im.status, 200);
  assert.ok(im.html.includes("Quero saber mais") && im.html.includes(`Cód. ${codigo}`) && im.html.includes("Plus Jakarta Sans"));
  for (const segredo of ["Construtora Segredo", "dono aceita", "Captador Interno"]) assert.ok(!im.html.includes(segredo), segredo);

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error(e);
  console.error("\n--- saída do servidor ---\n" + saida.slice(-3000));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
