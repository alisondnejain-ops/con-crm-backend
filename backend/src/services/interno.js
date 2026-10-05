/* O AMBIENTE INTERNO DO CONHUB (05/10/2026, pedido do Ali: "um ambiente
   virtual apenas para uso interno do ConHub, com todas as funcionalidades
   necessárias, de suporte à parte comercial… um CRM que não é imobiliário").

   Por dentro é uma conta como qualquer outra (`orgs.tipo = 'interna'`), e é
   por isso que sai barato: equipe com papéis, WhatsApp, funil, catraca,
   marketing, relatórios — tudo já existe e já é isolado por conta. O que muda
   é o que a conta NÃO é:

   - não é cliente: não aparece na lista de imobiliárias do hub, não tem
     mensalidade, teste nem bloqueio, e não pode ser apagada nem convertida;
   - não é imobiliária: o menu perde Imóveis e Plantão, a ficha perde a
     simulação e os campos de financiamento, a palavra-chave não sugere etapa
     de imóvel e o Autoatendimento (cujo texto atende comprador de imóvel) fica
     desligado;
   - é a casa do suporte: o número dela é o que manda os chamados ao WhatsApp
     do suporte, e a equipe dela responde os chamados de dentro do sistema.

   Existe UMA só. Duas contas internas fariam o suporte e o comercial do
   ConHub se dividirem sem ninguém saber em qual olhar. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { codigoLivre } from "./codigo.js";
import { criarPipeline, inserirEtapa } from "./pipelines.js";
import { FUNIL_INTERNO } from "./templates.js";

export const TIPO_INTERNO = "interna";

export const orgInterna = () =>
  db.prepare("SELECT * FROM orgs WHERE tipo = ? ORDER BY created_at LIMIT 1").get(TIPO_INTERNO) || null;

export function ehInterna(orgOuId) {
  if (!orgOuId) return false;
  if (typeof orgOuId === "object") return orgOuId.tipo === TIPO_INTERNO;
  return db.prepare("SELECT tipo FROM orgs WHERE id = ?").get(orgOuId)?.tipo === TIPO_INTERNO;
}

/* Quem é da equipe do ConHub: conta ativa DENTRO do ambiente interno.
   Conferido no banco, como o master — crachá antigo de quem saiu da equipe
   não abre a fila de chamados dos clientes. */
export function daEquipeConHub(userId) {
  if (!userId) return false;
  const u = db.prepare("SELECT u.status, o.tipo FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ?").get(userId);
  return !!u && u.status === "ativo" && u.tipo === TIPO_INTERNO;
}

/* Cria o ambiente — ou devolve o que já existe. O funil nasce junto: conta
   criada pelo hub só ganhava funil no reinício seguinte do servidor, e o
   ambiente interno não pode nascer com o Kanban vazio. */
export function criarAmbienteInterno(nome = "ConHub") {
  const existente = orgInterna();
  if (existente) return { org: existente, criado: false };
  const nomeLimpo = String(nome || "").trim() || "ConHub";
  const id = "org_" + randomUUID().slice(0, 8);
  const rodar = db.transaction(() => {
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at,tipo)
                VALUES (?,?,?,'',0,0,?,?)`).run(id, nomeLimpo, codigoLivre(nomeLimpo + " equipe"), Date.now(), TIPO_INTERNO);
  });
  rodar();
  const criado = criarPipeline(id, {
    name: FUNIL_INTERNO.nome, description: FUNIL_INTERNO.descricao, type: FUNIL_INTERNO.tipo, is_default: true,
  });
  if (!criado.erro) {
    db.transaction(() => FUNIL_INTERNO.etapas.forEach((e, i) => inserirEtapa(id, criado.pipeline.id, {
      name: e.name, color: e.color, status_type: e.tipo || "aberto",
      counts_as_conversion: !!e.conversao, sla_minutes: e.sla ?? null,
    }, i)))();
  }
  return { org: db.prepare("SELECT * FROM orgs WHERE id = ?").get(id), criado: true };
}

/* As etapas que o Painel conta como "agendado" e "realizado". Numa
   imobiliária são a visita ao imóvel; aqui, a demonstração do sistema. A
   conta é a mesma (`lead_etapas.para`), só o nome da etapa muda. */
export function etapasDeContagem(orgId) {
  return ehInterna(orgId)
    ? { agendada: "Demonstração agendada", realizada: "Demonstração feita", proposta: "Proposta" }
    : { agendada: "Agendamento", realizada: "Visita", proposta: "Proposta" };
}
