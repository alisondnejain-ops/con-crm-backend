/* OS DIREITOS DO TITULAR — LGPD, artigo 18. (02/09/2026)

   A lei brasileira dá ao dono do dado (aqui: o CLIENTE da imobiliária, não o
   corretor) o direito de perguntar o que a empresa tem sobre ele e de pedir
   que seja apagado. Até aqui o CRM não tinha resposta nenhuma para essas duas
   perguntas: a única forma de atender um pedido desses seria alguém abrir o
   banco na mão — e a única forma de "apagar" seria apagar o lead, levando
   junto o histórico que sustenta o relatório de quem atendeu.

   ===== POR QUE ANONIMIZAR, E NÃO APAGAR =====

   São duas obrigações que puxam para lados opostos, e as duas são reais:

   - o titular pede a ELIMINAÇÃO dos dados pessoais dele (art. 18, VI);
   - a imobiliária precisa manter o registro do atendimento — quantos leads o
     corretor recebeu, em quanto tempo respondeu, o que virou venda. Apagar a
     linha faria o relatório de agosto mudar em setembro, e a comissão de uma
     pessoa depender de um pedido de outra.

   A saída que a própria lei aponta é a ANONIMIZAÇÃO (art. 12): dado que não
   identifica mais ninguém deixa de ser dado pessoal. Então o que sai é tudo
   que aponta para a PESSOA — nome, telefone, e-mail, o texto das conversas, as
   fotos e os áudios, as observações, os campos do formulário. O que fica é o
   ESQUELETO: as datas, as etapas, quem atendeu, quantas mensagens houve. O
   relatório continua verdadeiro; o cliente some dele.

   É irreversível de propósito, e a rota diz isso antes de fazer.

   ===== E A EXPORTAÇÃO =====

   Um arquivo com tudo que existe sobre aquela pessoa, na hora, para a gestão
   responder a um pedido de acesso sem precisar de ninguém de fora. Ele traz o
   conteúdo das conversas: é justamente o que a pessoa tem direito de ver.
   Por isso a rota é só da gestão, e o pedido fica registrado no lead — quem
   exportou uma conversa inteira de um cliente precisa aparecer em algum lugar.

   ===== O QUE ESTE ARQUIVO NÃO RESOLVE =====

   Prazo de guarda (quanto tempo um lead perdido continua no sistema), base
   legal declarada e aviso de privacidade são decisões da imobiliária, não do
   código. Estão anotados no DEPLOY.md como pendência de quem opera. */

import db from "../db.js";

/* Tudo que o CRM sabe sobre um lead, num objeto só. */
export function exportar(orgId, leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return null;

  const nome = (id) => id ? db.prepare("SELECT name FROM users WHERE id = ?").get(id)?.name || null : null;

  return {
    gerado_em: new Date().toISOString(),
    aviso: "Documento gerado para atender a um pedido de acesso do titular (LGPD, art. 18). " +
           "Contém dados pessoais — trate como confidencial e entregue apenas ao próprio titular.",
    cadastro: {
      nome: lead.name, telefone: lead.phone, email: lead.email || null,
      origem: lead.origem, entrou_em: new Date(lead.created_at).toISOString(),
      etapa_atual: lead.stage, temperatura: lead.priority || null,
      responsavel: nome(lead.assigned_to),
      respostas_do_formulario: (() => { try { return JSON.parse(lead.qual_json || "{}"); } catch { return {}; } })(),
      campanha: lead.campaign_name || null, anuncio: lead.ad_name || null,
    },
    conversas: db.prepare(`SELECT direction, body, from_name, media_url, created_at
      FROM messages WHERE lead_id = ? ORDER BY created_at`).all(leadId).map(m => ({
        de: m.direction === "in" ? "o titular" : "a imobiliária",
        quem_escreveu: m.direction === "in" ? null : (m.from_name || null),
        texto: m.body, arquivo: m.media_url || null, em: new Date(m.created_at).toISOString(),
      })),
    ligacoes: db.prepare("SELECT * FROM ligacoes WHERE lead_id = ? ORDER BY created_at").all(leadId)
      .map(l => ({ em: new Date(l.created_at).toISOString(), resultado: l.resultado || null, observacao: l.obs || null })),
    observacoes: db.prepare("SELECT * FROM observacoes WHERE lead_id = ? ORDER BY created_at").all(leadId)
      .map(o => ({ texto: o.texto, por: nome(o.autor_id), em: new Date(o.created_at).toISOString() })),
    tarefas: db.prepare("SELECT titulo, quando, feito_em FROM tarefas WHERE lead_id = ? ORDER BY quando").all(leadId),
    simulacoes: db.prepare("SELECT * FROM simulacoes WHERE lead_id = ? ORDER BY created_at").all(leadId),
    historico_de_etapas: db.prepare(`SELECT de, para, motivo, created_at FROM lead_etapas
      WHERE lead_id = ? ORDER BY created_at`).all(leadId)
      .map(e => ({ de: e.de, para: e.para, motivo: e.motivo, em: new Date(e.created_at).toISOString() })),
    /* A leitura da IA entra porque é opinião gerada SOBRE a pessoa a partir dos
       dados dela — e o titular tem direito de saber que ela existe e o que
       diz. Esconder uma análise automatizada num pedido de acesso é
       exatamente o que o art. 20 não permite. */
    analises_automaticas: {
      resumo: (() => { try { return JSON.parse(lead.resumo_json || "null"); } catch { return null; } })(),
      etapa_lida_pela_ia: (() => { try { return JSON.parse(lead.etapa_ia_json || "null"); } catch { return null; } })(),
      temperatura_definida_por: lead.priority_por || null,
    },
  };
}

/* Apaga o que identifica a pessoa e mantém o esqueleto do atendimento.

   Um telefone é gravado como `5587991112222`; trocá-lo por vazio quebraria a
   coluna que o webhook usa para achar o lead — e um lead com telefone vazio
   viraria o destino de qualquer mensagem futura sem número. Por isso ele vira
   um marcador único e impossível de discar. */
export function anonimizar(orgId, leadId, { por = null } = {}) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return { erro: "Lead não encontrado." };
  if (lead.anonimizado_em) return { erro: "Este atendimento já foi anonimizado." };

  const marca = `anonimizado-${leadId.slice(-8)}`;
  const agora = Date.now();

  const rodar = db.transaction(() => {
    db.prepare(`UPDATE leads SET
        name = 'Titular anonimizado', phone = ?, email = NULL, qual_json = '{}',
        resumo_json = NULL, etapa_ia_json = NULL, robo_json = NULL, sugestao_etapa = NULL,
        anonimizado_em = ?, anonimizado_por = ?
      WHERE id = ?`).run(marca, agora, por, leadId);

    /* O TEXTO das mensagens sai; a CONTAGEM e as datas ficam. É o que preserva
       "quantas mensagens houve" e "em quanto tempo o corretor respondeu" — os
       números do relatório — sem guardar uma palavra do que foi dito. */
    db.prepare(`UPDATE messages SET body = '[conteúdo removido a pedido do titular]',
        body_original = NULL, media_url = NULL, media_mime = NULL, media_name = NULL
      WHERE lead_id = ?`).run(leadId);

    // Estes existem só para guardar coisas sobre a pessoa: somem inteiros.
    db.prepare("DELETE FROM observacoes WHERE lead_id = ?").run(leadId);
    db.prepare("DELETE FROM simulacoes WHERE lead_id = ?").run(leadId);
    db.prepare("UPDATE ligacoes SET obs = NULL WHERE lead_id = ?").run(leadId);
    db.prepare("UPDATE tarefas SET titulo = '[removido a pedido do titular]' WHERE lead_id = ?").run(leadId);
  });
  rodar();

  console.log(`[lgpd] atendimento ${leadId} anonimizado a pedido do titular`);
  return { ok: true, quando: agora };
}
