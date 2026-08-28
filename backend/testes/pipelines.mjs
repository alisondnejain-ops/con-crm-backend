/* O CORE DE GESTAO: pipelines, etapas configuraveis, SLA e campos obrigatorios.
   (28/08/2026)

   O funil era uma lista de 11 nomes escrita no servidor, igual para toda
   imobiliaria. Isto troca a lista por dado, e o que este teste tranca e, antes
   de qualquer recurso novo, que A OPERACAO QUE JA EXISTE NAO MUDE:

   1. imobiliaria antiga ganha o MESMO funil que ja usava, agora editavel;
   2. lead antigo continua na etapa em que estava, com o mesmo nome na tela;
   3. `leads.stage` (o nome) continua sendo escrito — trinta consultas e a tela
      inteira dependem dele, e o dia em que os dois divergirem o CRM comeca a
      mostrar um estado e a relatar outro;
   4. etapa com lead dentro nao some;
   5. SLA mede a partir da ULTIMA INTERACAO, nao da entrada na etapa;
   6. campo obrigatorio bloqueia a entrada e diz o que falta, pelo rotulo.

   Rodar:  npm run teste:pipelines
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-pipelines.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4627";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");

/* ===== UMA IMOBILIARIA COMO AS DE HOJE: sem pipeline, leads com etapa em texto ===== */
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "C-1", Date.now());
const uAdm = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,'Ali','ali@c.com','x','adm',1,?,'ativo')`).run(uAdm, org, Date.now());

const ANTIGAS = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda", "Perdido"];
ANTIGAS.forEach((etapa, i) => {
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)")
    .run("l_" + i, org, "Cliente " + i, "8799" + i, etapa, Date.now() - i * 86400000);
});
// Um lead com etapa que NAO esta na lista: importacao antiga, planilha torta.
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)")
  .run("l_orfao", org, "Veio de planilha", "87990000", "Etapa Estranha", Date.now());

const P = await import("../src/services/pipelines.js");
const { moverEtapa, camposQueFaltam, slaDoLead } = await import("../src/services/etapas.js");

let r;

console.log("1. A imobiliária que já existia ganha o funil que já usava");
/* A migração não pode mudar o que a equipe vê. Quem abre o CRM no dia seguinte
   tem que encontrar o mesmo funil — agora editável. */
r = P.garantirPipelinePadrao(org);
const pipelines = P.listarPipelines(org);
const etapas = P.etapasDoPipeline(org, pipelines[0].id);
console.log(`   criou ${pipelines.length} pipeline · ${etapas.length} etapas · ligou ${r.ligados} leads`);
assert.equal(pipelines.length, 1);
assert.equal(pipelines[0].is_default, true, "e ele é o padrão — lead novo precisa saber onde cair");
assert.deepEqual(etapas.map(e => e.name).slice(0, 9), ANTIGAS, "as etapas são exatamente as de antes, na ordem");

console.log("2. Rodar de novo não cria funil duplicado");
/* O bootstrap roda a cada start. Se não fosse idempotente, cada reinício do
   servidor daria à imobiliária mais um funil igual. */
P.garantirPipelinePadrao(org);
P.garantirPipelinePadrao(org);
assert.equal(P.listarPipelines(org).length, 1);
console.log("   três chamadas, um pipeline");

console.log("3. Cada lead antigo foi ligado à etapa dele, sem mudar de etapa");
const porNome = new Map(etapas.map(e => [e.name, e.id]));
for (let i = 0; i < ANTIGAS.length; i++) {
  const l = db.prepare("SELECT stage, stage_id, pipeline_id FROM leads WHERE id = ?").get("l_" + i);
  assert.equal(l.stage, ANTIGAS[i], "o nome na tela não pode ter mudado");
  assert.equal(l.stage_id, porNome.get(ANTIGAS[i]), "e agora tem vínculo");
  assert.ok(l.pipeline_id, "dentro de um pipeline");
}
console.log(`   ${ANTIGAS.length} leads, todos na mesma etapa de antes`);

console.log("4. O lead com etapa fora da lista NÃO foi descartado");
/* Base real tem lixo. Um lead que não casa com nenhuma etapa não pode sumir do
   funil nem virar erro — ele fica com o pipeline, sem vínculo de etapa, e
   continua aparecendo pelo nome como sempre apareceu. */
const orfao = db.prepare("SELECT stage, stage_id, pipeline_id FROM leads WHERE id = 'l_orfao'").get();
console.log(`   stage: "${orfao.stage}" · stage_id: ${orfao.stage_id} · pipeline: ${orfao.pipeline_id ? "sim" : "não"}`);
assert.equal(orfao.stage, "Etapa Estranha");
assert.equal(orfao.stage_id, null);
assert.ok(orfao.pipeline_id, "mas dentro do pipeline, para não ficar fora de tudo");

console.log("5. Mover um lead grava o NOME e o VÍNCULO juntos");
/* É a regra que sustenta a compatibilidade. Gravar só um dos dois deixa metade
   do CRM olhando para um estado e metade para outro. */
assert.equal(moverEtapa({ leadId: "l_0", para: "Atendimento", userId: uAdm }), true);
const movido = db.prepare("SELECT stage, stage_id, stage_entered_at FROM leads WHERE id = 'l_0'").get();
console.log(`   stage: ${movido.stage} · stage_id casa: ${movido.stage_id === porNome.get("Atendimento")}`);
assert.equal(movido.stage, "Atendimento");
assert.equal(movido.stage_id, porNome.get("Atendimento"));
assert.ok(movido.stage_entered_at, "e carimba desde quando está aqui — é a base do SLA");

console.log("6. Mover pelo ID da etapa dá no mesmo");
moverEtapa({ leadId: "l_1", paraEtapaId: porNome.get("Proposta"), userId: uAdm });
const porId = db.prepare("SELECT stage, stage_id FROM leads WHERE id = 'l_1'").get();
console.log(`   ${porId.stage}`);
assert.equal(porId.stage, "Proposta");
assert.equal(porId.stage_id, porNome.get("Proposta"));

console.log("7. Renomear uma etapa leva os leads junto");
/* O custo conhecido de guardar o nome no lead. Sem isto, o lead apontaria para
   um nome que não existe mais: some do kanban e do relatório, com o vínculo
   certo — o defeito parece ser de outro lugar. */
const idProposta = porNome.get("Proposta");
P.editarEtapa(org, idProposta, { name: "Proposta enviada" });
const renomeado = db.prepare("SELECT stage, stage_id FROM leads WHERE id = 'l_1'").get();
console.log(`   lead agora diz "${renomeado.stage}"`);
assert.equal(renomeado.stage, "Proposta enviada");
assert.equal(renomeado.stage_id, idProposta, "e continua sendo a mesma etapa");
P.editarEtapa(org, idProposta, { name: "Proposta" });

console.log("8. Etapa com lead dentro NÃO pode ser apagada");
r = P.apagarEtapa(org, porNome.get("Atendimento"));
console.log(`   ${r.erro}`);
assert.ok(r.erro);
assert.ok(/mova-os|desative/i.test(r.erro), "e a recusa diz o que fazer");
assert.equal(r.leads, 1);

console.log("9. Mas pode ser DESATIVADA — sai do fluxo sem sumir com ninguém");
P.editarEtapa(org, porNome.get("Atendimento"), { is_active: false });
const ativas = P.etapasDoPipeline(org, pipelines[0].id);
assert.ok(!ativas.find(e => e.id === porNome.get("Atendimento")), "sumiu da lista ativa");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id='l_0'").get().stage, "Atendimento",
  "e o lead continua exatamente onde estava");
console.log("   etapa fora do fluxo, lead intacto");
P.editarEtapa(org, porNome.get("Atendimento"), { is_active: true });

console.log("10. O último pipeline ativo não pode ser desligado");
/* Sem funil nenhum, o webhook do WhatsApp não tem onde colocar o lead que
   chega às 3 da manhã. */
r = P.editarPipeline(org, pipelines[0].id, { is_active: false });
console.log(`   ${r.erro}`);
assert.ok(/único pipeline ativo/i.test(r.erro));

console.log("\n11. Criar um pipeline a partir de template");
r = P.criarDoTemplate(org, "locacao", {});
console.log(`   ${r.pipeline.name}: ${r.etapas.map(e => e.name).join(" → ")}`);
assert.equal(r.etapas.length, 8);
assert.equal(r.etapas[0].name, "Lead novo");
assert.equal(r.pipeline.is_default, false, "template novo não rouba o padrão de quem já opera");
const locacao = r.pipeline.id;

console.log("12. O template traz SLA e marca o que conta como conversão");
const visita = r.etapas.find(e => e.name === "Visita");
const documentacao = r.etapas.find(e => e.name === "Documentação");
console.log(`   Visita: SLA ${visita.sla_minutes} min, conversão ${visita.counts_as_conversion}`);
console.log(`   Documentação: conversão ${documentacao.counts_as_conversion} (administrativa)`);
assert.ok(visita.sla_minutes > 0);
assert.equal(visita.counts_as_conversion, true);
assert.equal(documentacao.counts_as_conversion, false,
  "etapa administrativa não pode virar métrica falsa de conversão");
const locado = r.etapas.find(e => e.name === "Locado");
assert.equal(locado.status_type, "ganho", "o desfecho é marcado por tipo, não pelo nome");

console.log("13. Os quatro templates existem e todos têm desfecho marcado");
for (const t of P.TEMPLATES) {
  const ganho = t.etapas.filter(e => e.tipo === "ganho").length;
  console.log(`   ${t.nome.padEnd(24)} ${String(t.etapas.length).padStart(2)} etapas · ${ganho} de ganho`);
  assert.ok(t.etapas.length >= 6);
  assert.equal(ganho, 1, "todo fluxo precisa de um fim que conta como sucesso");
}

console.log("\n14. Duplicar um pipeline copia as etapas e não mexe no original");
/* É como se experimenta sem arriscar o que a equipe está usando agora. */
r = P.duplicarPipeline(org, locacao, "Locação — teste");
console.log(`   ${r.etapas.length} etapas copiadas`);
assert.equal(r.etapas.length, 8);
P.editarEtapa(org, r.etapas[0].id, { name: "Mexido na cópia" });
assert.equal(P.etapasDoPipeline(org, locacao)[0].name, "Lead novo", "o original ficou intacto");

console.log("15. Mover para etapa de OUTRO pipeline leva o lead para lá");
/* O movimento mais importante do produto: o SDR qualifica e o lead passa para o
   comercial. Aqui havia um COALESCE que preservava o pipeline antigo — o lead
   ficava com o funil A e a etapa de B, um estado que nenhum kanban consegue
   desenhar, porque a coluna não existe no funil em que ele diz estar. Não dava
   erro: só um lead que some da tela. */
const entradaLocacao = P.etapasDoPipeline(org, locacao)[0];
const antesDoMove = db.prepare("SELECT pipeline_id FROM leads WHERE id='l_2'").get().pipeline_id;
assert.notEqual(antesDoMove, locacao, "o lead começa em outro funil, senão o teste não prova nada");
moverEtapa({ leadId: "l_2", paraEtapaId: entradaLocacao.id, userId: uAdm });
const l2 = db.prepare("SELECT pipeline_id, stage_id, stage FROM leads WHERE id='l_2'").get();
console.log(`   saiu do funil antigo → ${l2.stage}, no pipeline de locação: ${l2.pipeline_id === locacao}`);
assert.equal(l2.pipeline_id, locacao, "o pipeline tem que acompanhar a etapa");
assert.equal(l2.stage_id, entradaLocacao.id);

console.log("16. E a troca de funil vira histórico de transferência");
/* `lead_etapas` responde "por quais etapas passou"; esta responde "por onde
   passou" — funil e dono, que é outra pergunta. */
const transf = db.prepare("SELECT * FROM lead_transfers WHERE lead_id='l_2' ORDER BY created_at DESC").all();
console.log(`   ${transf.length} transferência(s), disparada por ${transf[0].triggered_by_user_id === uAdm ? "quem mandou" : "?"}`);
assert.equal(transf.length, 1);
assert.equal(transf[0].from_pipeline_id, antesDoMove);
assert.equal(transf[0].to_pipeline_id, locacao);
assert.equal(transf[0].triggered_by_user_id, uAdm);

console.log("17. Pipeline com lead dentro não pode ser apagado");
r = P.apagarPipeline(org, locacao);
console.log(`   ${r.erro}`);
assert.ok(r.erro && /lead/i.test(r.erro));

console.log("\n===== SLA =====");
console.log("18. Etapa sem SLA configurado devolve null, não 'ok'");
/* Dizer "em dia" para uma etapa que ninguém configurou é inventar uma medição
   que não existe. */
const semSla = P.etapasDoPipeline(org, pipelines[0].id)[0];
assert.equal(slaDoLead(semSla, { last_interaction_at: Date.now() }), null);
console.log("   null — o CRM não mede o que não foi pedido");

console.log("19. O SLA conta da última INTERAÇÃO, não da entrada na etapa");
/* Lead que entrou ontem e conversou agora está saudável; lead que entrou hoje
   e ninguém tocou está abandonado. Medir pela entrada inverteria os dois. */
const etapaSla = { sla_minutes: 60, warning_before_minutes: 15 };
const agora = Date.now();
const conversouAgora = slaDoLead(etapaSla, { stage_entered_at: agora - 86400000, last_interaction_at: agora - 60000 }, agora);
const entrouAgora = slaDoLead(etapaSla, { stage_entered_at: agora - 300000, last_interaction_at: agora - 7200000 }, agora);
console.log(`   entrou ontem, conversou há 1 min  → ${conversouAgora.status}`);
console.log(`   entrou há 5 min, sem resposta 2h  → ${entrouAgora.status}`);
assert.equal(conversouAgora.status, "ok");
assert.equal(entrouAgora.status, "overdue");

console.log("20. E o aviso acende antes de vencer");
const quaseLa = slaDoLead(etapaSla, { last_interaction_at: agora - 50 * 60000 }, agora);
console.log(`   50 min de 60, aviso 15 antes → ${quaseLa.status} (restam ${quaseLa.restam} min)`);
assert.equal(quaseLa.status, "warning");
assert.equal(quaseLa.restam, 10);

console.log("21. Sem interação nenhuma, cai para a entrada na etapa");
/* Lead que nunca teve conversa não pode ficar fora de qualquer medição — é
   justamente o que mais precisa aparecer. */
const nunca = slaDoLead(etapaSla, { stage_entered_at: agora - 7200000, last_interaction_at: null }, agora);
assert.equal(nunca.status, "overdue");
console.log("   entrou há 2h e nunca teve interação → overdue");

console.log("\n===== CAMPOS OBRIGATORIOS =====");
console.log("22. Etapa sem exigência não bloqueia nada");
assert.deepEqual(camposQueFaltam(org, { required_fields: [] }, {}), []);
console.log("   lista vazia");

console.log("23. O que falta vem com o RÓTULO, não com a chave");
/* Quem lê é quem atende. "falta orcamento_max" não é uma frase que alguém
   saiba o que fazer com ela. */
db.prepare(`INSERT INTO custom_fields (id,org_id,name,key,type,ordem,is_active,created_at)
  VALUES ('cf1',?,'Orçamento máximo','orcamento_max','currency',0,1,?)`).run(org, Date.now());
const lead = db.prepare("SELECT * FROM leads WHERE id = 'l_3'").get();
const faltam = camposQueFaltam(org, { required_fields: ["orcamento_max"] }, lead);
console.log(`   ${JSON.stringify(faltam)}`);
assert.equal(faltam.length, 1);
assert.equal(faltam[0].label, "Orçamento máximo");

console.log("24. Campo preenchido some da lista");
db.prepare("UPDATE leads SET custom_fields = ? WHERE id = 'l_3'").run(JSON.stringify({ orcamento_max: 350000 }));
const depois = db.prepare("SELECT * FROM leads WHERE id = 'l_3'").get();
assert.deepEqual(camposQueFaltam(org, { required_fields: ["orcamento_max"] }, depois), []);
console.log("   preencheu, liberou");

console.log("25. Campo NATIVO do lead entra na mesma peneira");
/* Para quem monta o funil, "telefone" e "orçamento" são a mesma coisa:
   informação que precisa estar lá. Que uma seja coluna e a outra viva no JSON
   é assunto do banco. */
const semTemp = camposQueFaltam(org, { required_fields: ["telefone", "temperatura"] }, depois);
console.log(`   exigindo telefone + temperatura → falta: ${semTemp.map(f => f.key).join(", ")}`);
assert.equal(semTemp.length, 1, "o telefone está preenchido; a temperatura não");
assert.equal(semTemp[0].key, "temperatura");

console.log("\n===== CAMPANHA =====");
console.log("26. As colunas de atribuição existem e aceitam dado");
/* Estavam se perdendo: o webhook da Meta guardava só o meta_lead_id. É dado
   que não volta — lead de ontem sem campanha perdeu a atribuição para sempre. */
db.prepare(`UPDATE leads SET source='meta', platform='instagram', campaign_name='Lançamento Set',
  campaign_id='c1', adset_name='Interesse imóvel', adset_id='as1', ad_name='Vídeo 15s', ad_id='ad1',
  form_id='f1' WHERE id='l_4'`).run();
const comCampanha = db.prepare("SELECT * FROM leads WHERE id='l_4'").get();
console.log(`   ${comCampanha.platform} · ${comCampanha.campaign_name} · ${comCampanha.ad_name}`);
assert.equal(comCampanha.campaign_id, "c1");
assert.equal(comCampanha.platform, "instagram");

console.log("27. Dá para agrupar lead por campanha");
const porCampanha = db.prepare(`SELECT campaign_name, COUNT(*) n FROM leads
  WHERE org_id = ? AND campaign_name IS NOT NULL GROUP BY campaign_name`).all(org);
console.log(`   ${JSON.stringify(porCampanha)}`);
assert.equal(porCampanha.length, 1);

console.log("\n===== ISOLAMENTO ENTRE EMPRESAS =====");
console.log("28. Uma imobiliária não enxerga nem mexe no funil da outra");
const org2 = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org2, "Outra", "O-1", Date.now());
P.garantirPipelinePadrao(org2);
const daOutra = P.listarPipelines(org2);
assert.equal(daOutra.length, 1);
assert.notEqual(daOutra[0].id, pipelines[0].id);
// Com o id da outra na mão, ainda assim não passa.
assert.equal(P.pipelinePorId(org2, pipelines[0].id), undefined);
assert.equal(P.etapaPorId(org2, porNome.get("Venda")), undefined);
r = P.editarEtapa(org2, porNome.get("Venda"), { name: "Invadida" });
console.log(`   editar etapa da outra: ${r.erro}`);
assert.ok(r.erro, "e o id vazado não vira acesso");
assert.equal(P.etapaPorId(org, porNome.get("Venda")).name, "Venda", "a etapa original ficou intacta");

/* ===== BLOCO B: as regras em cima do movimento ===== */
const M = await import("../src/services/movimento.js");
const PA = await import("../src/services/painel.js");

console.log("\n===== CAMPO OBRIGATORIO BLOQUEIA O AVANCO =====");
console.log("29. A etapa exige, o lead não tem, o movimento não acontece");
/* A regra mora no moverLead e não na rota: lead muda de etapa por cinco
   caminhos, e regra que vale em um deles é pior que regra nenhuma. */
const idAprov = porNome.get("Aprovação");
P.editarEtapa(org, idAprov, { required_fields: ["orcamento_max"] });
const antesEtapa = db.prepare("SELECT stage FROM leads WHERE id='l_5'").get().stage;
r = M.moverLead({ leadId: "l_5", paraEtapaId: idAprov, userId: uAdm });
console.log(`   ${r.error}`);
assert.equal(r.bloqueado, true);
assert.equal(r.faltam[0].label, "Orçamento máximo", "diz o rótulo, não a chave");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id='l_5'").get().stage, antesEtapa,
  "e o lead NAO se mexeu — bloquear depois de mover é não bloquear");

console.log("30. Preenchido, passa");
db.prepare("UPDATE leads SET custom_fields=? WHERE id='l_5'").run(JSON.stringify({ orcamento_max: 300000 }));
r = M.moverLead({ leadId: "l_5", paraEtapaId: idAprov, userId: uAdm });
assert.equal(r.ok, true);
assert.equal(db.prepare("SELECT stage FROM leads WHERE id='l_5'").get().stage, "Aprovação");
console.log("   moveu");

console.log("31. `forcar` existe para o fato consumado");
/* A venda registrada leva o lead para a etapa de ganho porque a venda
   ACONTECEU. Segurar isso por falta de um campo seria o CRM discordando de um
   fato que já é verdade no mundo. */
P.editarEtapa(org, porNome.get("Venda"), { required_fields: ["nunca_preenchido"] });
r = M.moverLead({ leadId: "l_6", paraEtapaId: porNome.get("Venda"), userId: uAdm, forcar: true });
assert.equal(r.ok, true);
console.log("   venda registrada entra mesmo com campo faltando");
P.editarEtapa(org, porNome.get("Venda"), { required_fields: [] });

console.log("\n===== DISTRIBUICAO AUTOMATICA =====");
console.log("32. A etapa distribui por rodízio ao receber o lead");
/* O caso principal do sprint: o lead chega em "qualificado" e vai sozinho para
   um corretor. */
const c1 = "u_c1", c2 = "u_c2";
for (const [id, nome] of [[c1, "Marina"], [c2, "Rafael"]])
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(id, org, nome, nome + "@c.com", Date.now());
const idAgend = porNome.get("Agendamento");
P.editarEtapa(org, idAgend, { automation_config: { distribuir: "rodizio" } });
r = M.moverLead({ leadId: "l_7", paraEtapaId: idAgend, userId: uAdm });
console.log(`   entregue a ${r.responsavel_nome}`);
assert.ok(r.responsavel, "alguém recebeu");
const dono1 = r.responsavel;

console.log("33. E o próximo lead vai para OUTRA pessoa");
r = M.moverLead({ leadId: "l_8", paraEtapaId: idAgend, userId: uAdm });
console.log(`   entregue a ${r.responsavel_nome}`);
assert.notEqual(r.responsavel, dono1, "o rodízio girou");

console.log("34. Sem ninguém disponível, o aviso é EXPLÍCITO");
/* Lead que entra sem dono parecendo distribuído é lead que ninguém atende, e
   ninguém descobre até o cliente reclamar. */
db.prepare("UPDATE users SET available = 0 WHERE id IN (?,?)").run(c1, c2);
db.prepare("UPDATE users SET available = 0 WHERE org_id = ? AND role IN ('corretor','sdr')").run(org);
r = M.moverLead({ leadId: "l_orfao", paraEtapaId: idAgend, userId: uAdm });
console.log(`   ${r.aviso}`);
assert.ok(r.ok, "o lead move mesmo assim");
assert.ok(/ninguém está disponível/i.test(r.aviso || ""), "e o aviso diz o que houve");

console.log("35. A etapa também pode empurrar o lead para OUTRO funil");
/* SDR qualifica → comercial, sozinho. */
db.prepare("UPDATE users SET available = 1 WHERE id = ?").run(c1);
const sdrPipe = P.criarDoTemplate(org, "sdr", {});
const qualificado = sdrPipe.etapas.find(e => e.name === "Lead qualificado");
P.editarEtapa(org, qualificado.id, {
  automation_config: { mover_para_pipeline: pipelines[0].id, distribuir: "rodizio" } });
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES ('l_sdr',?,'Do SDR','8791',?,?)")
  .run(org, sdrPipe.etapas[0].name, Date.now());
db.prepare("UPDATE leads SET pipeline_id=?, stage_id=? WHERE id='l_sdr'").run(sdrPipe.pipeline.id, sdrPipe.etapas[0].id);
r = M.moverLead({ leadId: "l_sdr", paraEtapaId: qualificado.id, userId: uAdm });
const doSdr = db.prepare("SELECT pipeline_id, stage, assigned_to FROM leads WHERE id='l_sdr'").get();
console.log(`   foi para o funil comercial: ${doSdr.pipeline_id === pipelines[0].id} · dono: ${!!doSdr.assigned_to}`);
assert.equal(doSdr.pipeline_id, pipelines[0].id, "trocou de funil sozinho");
assert.ok(doSdr.assigned_to, "e chegou com dono");

console.log("36. A automação NUNCA derruba a movimentação");
/* Configuração errada do gestor não pode virar uma etapa em que ninguém
   consegue entrar. */
P.editarEtapa(org, idAgend, { automation_config: { mover_para_pipeline: "pipeline_que_nao_existe" } });
r = M.moverLead({ leadId: "l_3", paraEtapaId: idAgend, userId: uAdm });
console.log(`   ok: ${r.ok} · aviso: ${r.aviso}`);
assert.equal(r.ok, true, "o lead moveu");
assert.ok(r.aviso, "e o problema virou aviso, não exceção");
P.editarEtapa(org, idAgend, { automation_config: {} });

console.log("\n===== TROCA DE RESPONSAVEL VIRA HISTORICO =====");
console.log("37. Quem estava com o lead antes fica registrado");
const antesDono = db.prepare("SELECT assigned_to FROM leads WHERE id='l_7'").get().assigned_to;
M.trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id='l_7'").get(), c2, uAdm, "mao");
const hist = M.transferenciasDoLead("l_7");
console.log(`   ${hist.length} registro(s), o último de ${hist[0].de_nome || "ninguém"} para ${hist[0].para_nome}`);
assert.equal(hist[0].from_user_id, antesDono);
assert.equal(hist[0].to_user_id, c2);

console.log("\n===== PAINEL =====");
console.log("38. Os períodos são resolvidos no servidor");
/* Ficavam no navegador, e o "mês atual" do aparelho em outro fuso não era o
   mesmo do relatório — dois números divergindo sem motivo aparente. */
for (const id of ["hoje", "ontem", "semana", "mes", "90dias", "ano"]) {
  const p2 = PA.resolverPeriodo({ periodo: id });
  assert.ok(p2.de && p2.ate && p2.de <= p2.ate, id);
}
console.log("   hoje, ontem, semana, mês, 90 dias e ano");

console.log("39. O painel responde com números, não com invenção");
const d = PA.painel(org, { periodo: "ano" });
console.log(`   recebidos ${d.atendimento.recebidos} · SLA vencidos ${d.sla.vencidos} · sem SLA ${d.sla.sem_sla_configurado}`);
assert.ok(typeof d.atendimento.recebidos === "number");
assert.ok(typeof d.sla.sem_sla_configurado === "number",
  "quantos estão FORA de qualquer medição — sem isso '0 vencidos' engana");

console.log("40. Sem ninguém respondido, o tempo é null e não zero");
/* Zero e 'não sei' são coisas diferentes: a primeira é um fato, a segunda é
   uma lacuna. Trocar uma pela outra faz decidir sobre número que ninguém mediu. */
const vazio = PA.painel(org2, { periodo: "hoje" });
console.log(`   mediana: ${vazio.atendimento.primeira_resposta_mediana_min}`);
assert.equal(vazio.atendimento.primeira_resposta_mediana_min, null);
assert.equal(vazio.atendimento.recebidos, 0, "mas a contagem é zero, que é um fato");

console.log("41. O funil separa CONVERSÃO de AVANÇO OPERACIONAL");
const f = PA.funil(org, pipelines[0].id, { periodo: "ano" });
const nomesConv = f.conversao.map(c => c.name);
const nomesOper = f.operacional.map(o => o.name);
console.log(`   conversão: ${nomesConv.length} degraus · operacional: ${nomesOper.length} etapas`);
assert.ok(nomesOper.length > nomesConv.length, "o operacional mostra tudo; a conversão, só os degraus");
assert.ok(!nomesConv.includes("Pasta"), "etapa administrativa fica fora da conversão");
assert.ok(nomesOper.includes("Pasta"), "mas aparece no avanço operacional");

console.log("42. E o funil sem degrau marcado avisa, em vez de mostrar gráfico vazio");
const semDegrau = P.criarPipeline(org, { name: "Sem degraus" });
P.criarEtapa(org, semDegrau.pipeline.id, { name: "Única" });
const fv = PA.funil(org, semDegrau.pipeline.id, { periodo: "ano" });
console.log(`   sem_degraus: ${fv.sem_degraus} · conversao: ${fv.conversao}`);
assert.equal(fv.sem_degraus, true);
assert.equal(fv.conversao, null, "null e não [] — é ausência de configuração, não funil vazio");

console.log("43. O avanço operacional traz tempo mediano e atrasados por etapa");
const comLeads = f.operacional.find(o => o.leads_agora > 0);
console.log(`   ${comLeads.name}: ${comLeads.leads_agora} lead(s), mediana ${comLeads.tempo_mediano_dias} dia(s)`);
assert.ok(typeof comLeads.tempo_mediano_dias === "number");

console.log("44. Campanha: agrupa e é honesto sobre a cobertura");
/* Dizer que 1 de 12 leads tem campanha é o que impede alguém de ler o painel
   como se fosse a operação inteira. */
const camp = PA.campanhas(org, { periodo: "ano" });
console.log(`   ${camp.campanhas.length} grupo(s) · cobertura ${camp.cobertura.pct}% (${camp.cobertura.com_campanha}/${camp.cobertura.total})`);
assert.ok(camp.campanhas.length >= 1);
assert.ok(camp.cobertura.aviso, "e o aviso explica por que a cobertura é parcial");
const lancamento = camp.campanhas.find(c => c.campanha === "Lançamento Set");
assert.ok(lancamento, "a campanha gravada aparece");

console.log("45. A equipe: quem tem lead parado e quanto produziu");
const eq = PA.atividades(org, PA.resolverPeriodo({ periodo: "ano" }), {});
const marina = eq.find(p2 => p2.nome === "Marina");
console.log(`   ${marina.nome}: ${marina.leads_na_mao} na mão, ${marina.sla_vencidos} vencidos, ${marina.aguardando_resposta} esperando`);
assert.ok(typeof marina.leads_na_mao === "number");
assert.ok(typeof marina.sla_vencidos === "number");

console.log("46. As opções do filtro saem da base, não de lista fixa");
/* Lista fixa mostraria campanha que nunca existiu e esconderia a que existe. */
const op = PA.opcoesDeFiltro(org);
console.log(`   ${op.pipelines.length} funis · ${op.pessoas.length} pessoas · ${op.campanhas.length} campanha(s)`);
assert.ok(op.campanhas.includes("Lançamento Set"));
assert.ok(op.pipelines[0].stages.length, "e cada funil vem com as etapas, para o filtro encadear");

console.log("47. O painel filtra por pipeline, pessoa e campanha");
const soMarina = PA.painel(org, { periodo: "ano", responsavel: c1 });
const tudo = PA.painel(org, { periodo: "ano" });
console.log(`   toda a base: ${tudo.sla.total_em_aberto} · só da Marina: ${soMarina.sla.total_em_aberto}`);
assert.ok(soMarina.sla.total_em_aberto < tudo.sla.total_em_aberto, "o filtro realmente peneira");
const porCamp = PA.painel(org, { periodo: "ano", campanha: "Lançamento Set" });
assert.equal(porCamp.sla.total_em_aberto, 1);

console.log("\nTudo certo ✅");
process.exit(0);
