/* Arrumar a base inteira: temperatura e etapa pela IA.

   São operações que mexem em centenas de leads de uma vez, então o que este
   teste protege é sobretudo QUEM FICA DE FORA:

   - lead da atendente (SDR) não entra. Ela faz o primeiro contato e repassa; o
     que ainda está com ela não é atendimento de corretor nenhum, e mexer na
     etapa sujaria o relatório de quem não o atendeu. Foi pedido explícito do
     Ali por causa da Vanessa;
   - lead sem conversa não entra — não há o que a IA ler, ela inventaria;
   - venda registrada e etapa marcada na mão não são tocadas.

   E que a temperatura "Morno" só apaga os mornos: Quente e Frio ficam.

   A chamada à Anthropic é trocada por uma resposta de mentira: roda offline.

   Rodar:  npm run teste:lote
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-lote.db");
process.env.JWT_SECRET = "teste";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

/* A IA de mentira responde as duas perguntas: etapa e temperatura. Qual delas
   foi feita se descobre pelo texto do pedido — é o mesmo endpoint. */
const real = globalThis.fetch;
let chamadas = 0, chamadasTemp = 0, falharDeProposito = false;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("api.anthropic.com")) return real(url, opts);
  const pedido = String(opts && opts.body || "");
  const ehTemperatura = pedido.includes("PERTO DE COMPRAR");
  // Para o caso 18: a IA fora do ar não pode marcar lead nenhum.
  if (falharDeProposito) return { ok: false, status: 500, json: async () => ({ error: { message: "provedor fora do ar" } }), text: async () => "provedor fora do ar" };
  if (ehTemperatura) chamadasTemp++; else chamadas++;
  const resposta = ehTemperatura
    ? { temperatura: "QUENTE", confianca: "alta", porque: "O cliente pediu para visitar." }
    : { etapa: "Pasta", confianca: "alta", porque: "O cliente enviou os documentos.", trecho: "segue aí" };
  return { ok: true, status: 200, json: async () => ({
    content: [{ type: "text", text: JSON.stringify(resposta) }],
    usage: { input_tokens: 900, output_tokens: 80 } }) };
};

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { previaTemperatura, limparTemperatura, previaEtapaIA, rodarEtapaIA,
  corretoresParaTemperatura, previaTemperaturaIA, rodarTemperaturaIA } = await import("../src/services/lote.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const vanessa = user("Vanessa", "sdr"), marina = user("Marina", "corretor"), ali = user("Ali", "adm");

let n = 0;
function lead({ nome, dono, temp = "MORNO", etapa = "Atendimento", conversa = true, venda = false }) {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,priority,stage,assigned_to,created_at,sale_value,sale_date)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, org, nome, "558790000" + (1000 + n++), temp, etapa, dono,
      Date.now(), venda ? 200000 : null, venda ? Date.now() : null);
  if (conversa) {
    db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
      .run("m_" + randomUUID(), id, "in", "oi, quero comprar", Date.now());
    db.prepare("INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at) VALUES (?,?,?,?,?,?)")
      .run("m_" + randomUUID(), id, "out", dono, "segue aí, me manda os documentos", Date.now() + 1000);
  }
  return id;
}

const doCorretor = lead({ nome: "Do corretor", dono: marina });
const outroDoCorretor = lead({ nome: "Outro do corretor", dono: marina, temp: "QUENTE" });
const daVanessa = lead({ nome: "Da Vanessa", dono: vanessa });
const semConversa = lead({ nome: "Sem conversa", dono: marina, conversa: false });
const comVenda = lead({ nome: "Vendido", dono: marina, etapa: "Venda", venda: true });
const naMao = lead({ nome: "Perdido na mão", dono: marina, etapa: "Perdido" });
const frio = lead({ nome: "Marcado frio", dono: marina, temp: "FRIO" });
lead({ nome: "Sem dono", dono: null });

console.log("1. A prévia da temperatura conta só os mornos");
const pt = previaTemperatura(org, "MORNO");
console.log(`   ${pt.leads} mornos de ${pt.total} · ficam: ${pt.restam.map(x => x.p + "=" + x.n).join(", ")}`);
assert.equal(pt.leads, 6, "os seis que ficaram com o MORNO padrão");
assert.deepEqual(pt.restam.sort((a, b) => a.p.localeCompare(b.p)),
  [{ p: "FRIO", n: 1 }, { p: "QUENTE", n: 1 }], "Quente e Frio não são mexidos");

console.log("2. Limpar apaga só a marcação, e só dos mornos");
const lim = limparTemperatura(org, "MORNO");
assert.equal(lim.limpos, 6);
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(doCorretor).p, null, "ficou sem temperatura");
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(outroDoCorretor).p, "QUENTE");
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(frio).p, "FRIO");
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=?").get(org).n, 8, "nenhum lead foi apagado");

console.log("3. A prévia da IA separa quem entra de quem fica de fora");
const p = previaEtapaIA(org);
console.log(`   entram ${p.leads} · com a atendente/sem dono ${p.fora.com_atendente_ou_sem_dono}` +
  ` · sem conversa ${p.fora.sem_conversa} · venda ${p.fora.venda_registrada} · etapa manual ${p.fora.etapa_manual}`);
console.log(`   custo estimado: US$ ${p.custo.total_usd}`);
assert.equal(p.leads, 3, "só os do corretor, com conversa, sem venda e em etapa do funil");
assert.equal(p.fora.com_atendente_ou_sem_dono, 2, "o da Vanessa e o sem dono");
assert.equal(p.fora.sem_conversa, 1);
assert.equal(p.fora.venda_registrada, 1);
assert.equal(p.fora.etapa_manual, 1);
assert.ok(p.custo.total_usd > 0, "o preço aparece antes de rodar");

console.log("4. Rodando: só os elegíveis são lidos");
const r = await rodarEtapaIA(org, { limite: 50, userId: ali });
console.log(`   leu ${r.analisados} · mudou ${r.mudaram} · faltam ${r.restam} · chamadas à IA: ${chamadas}`);
assert.equal(r.analisados, 3);
assert.equal(chamadas, 3, "uma chamada por lead elegível, nem uma a mais");

console.log("5. O lead da Vanessa NÃO foi tocado");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(daVanessa).stage, "Atendimento");
assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id=?").get(daVanessa).n, 0);

console.log("6. Nem o vendido, nem o perdido na mão, nem o sem conversa");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(comVenda).stage, "Venda");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(naMao).stage, "Perdido");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(semConversa).stage, "Atendimento");

console.log("7. Os do corretor foram para a etapa que a IA leu, com rastro");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(doCorretor).stage, "Pasta");
const hist = db.prepare("SELECT de,para,motivo FROM lead_etapas WHERE lead_id=?").get(doCorretor);
console.log(`   ${hist.de} → ${hist.para} (motivo: ${hist.motivo})`);
assert.equal(hist.motivo, "ia_lote", "dá para separar depois do que foi palavra-chave e do que foi clique");

console.log("8. Rodar de novo não paga duas vezes pelas mesmas conversas");
const antes = chamadas;
const r2 = await rodarEtapaIA(org, { limite: 50, userId: ali });
console.log(`   leu ${r2.analisados} · chamadas novas: ${chamadas - antes}`);
assert.equal(chamadas, antes, "nenhuma chamada nova");

console.log("9. O gasto ficou registrado com dono");
const { resumoDeUso } = await import("../src/services/iauso.js");
const uso = resumoDeUso(org, 30);
console.log(`   ${uso.total.usos} uso(s) · US$ ${uso.total.custo}`);
assert.equal(uso.total.usos, 3);
assert.equal(uso.por_pessoa[0].nome, "Ali", "no nome de quem mandou rodar");

console.log("10. A temperatura pela IA lista os corretores, e só eles");
const lista = corretoresParaTemperatura(org);
console.log(`   ${lista.corretores.map(c => c.nome + "=" + c.leads).join(", ") || "(ninguém)"}`);
assert.equal(lista.corretores.length, 1, "a Vanessa é SDR: não entra na análise de corretor");
assert.equal(lista.corretores[0].nome, "Marina");
assert.equal(lista.corretores[0].leads, 3, "os mesmos elegíveis da etapa");

console.log("11. Pedir a análise da SDR é recusado, com o motivo escrito");
const naoPode = previaTemperaturaIA(org, vanessa);
console.log(`   ${naoPode.erro}`);
assert.ok(naoPode.erro && /atendente/i.test(naoPode.erro), "a recusa explica por que a SDR fica de fora");

console.log("12. A prévia de um corretor diz quantos e quanto custa");
const pq = previaTemperaturaIA(org, marina);
console.log(`   ${pq.corretor.nome}: ler ${pq.a_ler}, já lidos ${pq.ja_lidos} · US$ ${pq.custo.total_usd}`);
assert.equal(pq.a_ler, 3);
assert.equal(pq.ja_lidos, 0);
assert.ok(pq.custo.total_usd > 0, "o preço aparece antes de rodar");

console.log("13. Rodando: só os leads DAQUELE corretor recebem temperatura");
const rt = await rodarTemperaturaIA(org, { corretorId: marina, limite: 50, userId: ali });
console.log(`   leu ${rt.analisados} · quente ${rt.contagem.QUENTE} · chamadas de temperatura: ${chamadasTemp}`);
assert.equal(rt.analisados, 3);
assert.equal(chamadasTemp, 3, "uma chamada por lead do corretor, nem uma a mais");
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(doCorretor).p, "QUENTE");

console.log("14. A marcação diz que veio da IA, e quando");
const marcado = db.prepare("SELECT priority, priority_por, priority_em FROM leads WHERE id=?").get(doCorretor);
console.log(`   ${marcado.priority} · por ${marcado.priority_por}`);
assert.equal(marcado.priority_por, "ia", "dá para separar o que a IA leu do que a pessoa marcou");
assert.ok(marcado.priority_em > 0);

console.log("15. O lead da Vanessa continua SEM temperatura");
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(daVanessa).p, null);
assert.equal(db.prepare("SELECT priority p FROM leads WHERE id=?").get(semConversa).p, null, "sem conversa, sem leitura");

console.log("16. Rodar de novo no mesmo dia não paga duas vezes");
const antesT = chamadasTemp;
const rt2 = await rodarTemperaturaIA(org, { corretorId: marina, limite: 50, userId: ali });
console.log(`   leu ${rt2.analisados} · chamadas novas: ${chamadasTemp - antesT}`);
assert.equal(chamadasTemp, antesT, "nenhuma chamada nova");

console.log("17. O gasto da temperatura entrou no Uso da IA, separado da etapa");
const uso2 = resumoDeUso(org, 30);
const porRecurso = Object.fromEntries(uso2.por_recurso.map(x => [x.recurso, x.usos]));
console.log(`   ${uso2.por_recurso.map(x => x.rotulo + "=" + x.usos).join(" · ")}`);
assert.equal(porRecurso.etapa, 3);
assert.equal(porRecurso.temperatura, 3);

console.log("18. Quando a IA falha, o lead NÃO fica marcado — e é tentado de novo");
const novo = lead({ nome: "Chegou depois", dono: marina, temp: null });
falharDeProposito = true;
const ruim = await rodarTemperaturaIA(org, { corretorId: marina, limite: 50, userId: ali });
console.log(`   tentou ${ruim.analisados} · marcou ${ruim.marcados} · erro: ${(ruim.erros[0]||{}).erro}`);
assert.equal(ruim.analisados, 1, "o lead novo entrou na fila");
assert.equal(ruim.marcados, 0, "a tela precisa saber que NENHUM foi marcado");
assert.equal(ruim.erros.length, 1, "e o motivo vem junto");
const cru = db.prepare("SELECT priority, priority_por FROM leads WHERE id=?").get(novo);
assert.equal(cru.priority, null, "sem temperatura inventada");
assert.equal(cru.priority_por, null, "e sem marca de leitura: a falha era da instalação, não da conversa");

falharDeProposito = false;
const bom = await rodarTemperaturaIA(org, { corretorId: marina, limite: 50, userId: ali });
console.log(`   depois de consertar: tentou ${bom.analisados} · marcou ${bom.marcados}`);
assert.equal(bom.marcados, 1, "consertou a IA, rodou de novo, funcionou na hora");

console.log("\nTudo certo ✅");
