/* O TELEFONE DO LEAD, NO FORMATO DO WHATSAPP — DE QUALQUER PAÍS (03/10/2026).

   Até aqui tudo era lido como brasileiro: 11 dígitos ganhavam "55" na frente,
   12 começando por 55 ganhavam o nono dígito. Para uma imobiliária que vende a
   estrangeiros isso estragava o número sem erro nenhum aparecer — o celular
   americano 202 555-0123, que chega do WhatsApp como 12025550123 (11 dígitos),
   virava 5512025550123: um número de São José dos Campos que não é de
   ninguém. O lead nascia, a resposta do CRM não chegava e a mensagem seguinte
   do cliente criava um SEGUNDO lead.

   As regras, em ordem:

   1. O número que JÁ TEM o código do país fica como veio. Isso vale para o que
      chega do WhatsApp (`comCodigo` — o número do remetente sempre traz o
      país) e para o que alguém escreveu com "+" ou "00" na frente. Só o
      Brasil ganha um ajuste aqui: 55 + DDD + 8 dígitos recebe o nono dígito,
      como sempre recebeu (é o que casa a conversa com o lead cadastrado).

   2. Sem o código, vale o PAÍS escolhido (padrão: Brasil). Para o Brasil, a
      regra de sempre, sem mudança nenhuma — é ela que todo lead da base já
      seguiu, e mudá-la partiria conversas antigas em duas. Para outro país, o
      código dele vai na frente e o zero de longa distância sai (menos na
      Itália, onde o zero faz parte do número).

   3. Quem escolheu o país e AINDA ASSIM digitou o código junto ("54 9 11…"
      com Argentina escolhida) não ganha o código duas vezes: um número que
      começa pelo código e é comprido demais para ser nacional já o tem.

   A função continua PERMISSIVA, como era: no webhook, devolver os dígitos que
   vieram é melhor do que perder o lead. Quem cria o registro na mão confere
   com `validarTelefone`. */
import { PAISES } from "./paises.js";

const PAIS_BR = PAISES.find(p => p.iso === "BR");
// Mais longo primeiro: "351" (Portugal) tem que ganhar de "35…" se algum dia existir.
const POR_DDI = [...PAISES].sort((a, b) => b.ddi.length - a.ddi.length);

export const paisPorIso = (iso) => PAISES.find(p => p.iso === String(iso || "").toUpperCase()) || null;

/* De que país é um número que já tem o código. Nulo quando o código não está
   na lista — o número continua valendo, só não sabemos dizer o país. */
export function paisDoNumero(numero) {
  const d = String(numero || "").replace(/\D/g, "");
  return POR_DDI.find(p => d.startsWith(p.ddi)) || null;
}

// A regra brasileira de sempre, exatamente como era antes de 03/10/2026.
function brasil(d) {
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 11) return "55" + d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

export function normalizePhone(raw, { pais = "BR", comCodigo = false } = {}) {
  const txt = String(raw || "").trim();
  let d = txt.replace(/\D/g, "");
  if (!d) return "";

  // 1. Já tem o código do país.
  let internacional = comCodigo || txt.startsWith("+");
  if (!internacional && d.startsWith("00")) { d = d.replace(/^00/, ""); internacional = true; }
  if (internacional) return d.length === 12 && d.startsWith("55") ? brasil(d) : d;

  // 2. Sem código: o país escolhido.
  const p = paisPorIso(pais) || PAIS_BR;
  if (p.iso === "BR") return brasil(d);

  // 3. Escolheu o país e digitou o código junto.
  const resto = d.length - p.ddi.length;
  if (d.startsWith(p.ddi) && d.length > p.max && resto >= p.min && resto <= p.max) return d;

  let n = p.zero ? d : d.replace(/^0+/, "");
  /* Argentina: no WhatsApp, celular é 54 + 9 + área + número. Quem digita o
     número como ele é discado no país (área + número, 10 dígitos) chegaria a
     um número que o WhatsApp não conhece. Fixo argentino com WhatsApp é raro,
     e se for o caso o envio tenta a forma sem o 9 (`numeroAlternativo`). */
  if (p.iso === "AR" && n.length === 10) n = "9" + n;
  return p.ddi + n;
}

/* Confere o número de quem está CRIANDO o registro (cadastro na mão, correção
   na ficha, planilha). Devolve a frase do problema, ou null quando está bom.

   O Brasil continua exigindo DDD + 8 ou 9 dígitos. Para os outros países a
   conferência é o tamanho: o geral do padrão internacional (8 a 15 dígitos
   contando o código) e, quando o código é de um país da lista, o tamanho
   nacional dele — é o que pega "esqueceu dois dígitos", que é o erro comum. */
export function validarTelefone(numero) {
  const d = String(numero || "").replace(/\D/g, "");
  if (d.startsWith("55"))
    return /^55\d{10,11}$/.test(d) ? null : "Informe um telefone válido, com DDD (ex.: 87 99999-8888).";
  const incompleto = "Número incompleto: confira o país e o número.";
  if (d.length < 8 || d.length > 15) return incompleto;
  /* Código fora da lista: vale, desde que tenha pelo menos 10 dígitos. O
     menor número internacional de verdade com WhatsApp anda por aí (Cabo
     Verde, Noruega, Panamá: código + 7 ou 8). Abaixo disso, quase sempre é um
     número brasileiro sem DDD — que não ganhou o 55 justamente por faltar
     dígito. */
  const p = paisDoNumero(d);
  if (!p) return d.length >= 10 ? null : incompleto;
  const n = d.length - p.ddi.length;
  if (n < p.min || n > p.max)
    return `Esse número não parece completo para ${p.nome} (+${p.ddi}): ${n} dígito(s) depois do código, o esperado é ${p.min === p.max ? p.min : `${p.min} a ${p.max}`}.`;
  return null;
}

export const telefoneValido = (numero) => !validarTelefone(numero);
