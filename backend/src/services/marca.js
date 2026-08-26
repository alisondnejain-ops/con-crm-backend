/* A MARCA DA IMOBILIÁRIA: logo e cor da barra.

   A plataforma sempre foi multi-imobiliária por dentro — org própria, código
   próprio, WhatsApp próprio, assinatura própria. Por fora era uma só: a mesma
   cor e o mesmo nome para todo mundo. Quem assina o sistema não pode ver a
   marca de outra imobiliária na tela da própria equipe.

   AQUI SÓ MORA A COR DA BARRA, e é de propósito.

   Coral e âmbar continuam fixos no código. Eles não são enfeite: são o
   cronômetro que esquenta, a tarefa vencida, o lead parado. Se a imobiliária
   escolhesse vermelho como cor de marca, a tela inteira ficaria vermelha e o
   sinal de urgência deixaria de existir — a personalização apagaria justamente
   a informação que o CRM existe para dar.

   E COR CLARA É RECUSADA, com a versão escura da MESMA cor na resposta.

   A barra escreve em branco. Cor clara demais não deixa a barra feia: deixa a
   barra ilegível, e quem escolheu não descobre na hora — descobre quando um
   corretor disser que não enxerga o menu. Recusar sem oferecer saída empurra o
   gestor a desistir da própria cor; por isso a recusa vem com um tom mais
   escuro da cor dele, pronto para usar. */

/* Luminância relativa (WCAG). Não é "quão claro parece": é quanta luz a cor
   emite de fato, com o verde pesando mais que o vermelho e muito mais que o
   azul, porque é assim que o olho funciona. Um amarelo e um azul do mesmo
   "tom" no seletor de cor têm luminâncias muito diferentes. */
export function luminancia(hex) {
  const n = hex.replace("#", "");
  const canal = (i) => {
    const v = parseInt(n.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

/* Quantas vezes o branco é mais claro que a cor. 4.5 é o mínimo que a norma de
   acessibilidade pede para texto pequeno — e o menu da barra é texto pequeno. */
export const contrasteComBranco = (hex) => 1.05 / (luminancia(hex) + 0.05);

export const CONTRASTE_MINIMO = 4.5;
export const COR_PADRAO = "#0A3D30";

const HEX = /^#?[0-9a-fA-F]{6}$/;
export const normalizarHex = (v) => {
  const t = String(v || "").trim();
  return HEX.test(t) ? "#" + t.replace("#", "").toUpperCase() : null;
};

/* Escurece a cor mantendo o TOM dela — multiplica os três canais pelo mesmo
   fator, então azul continua azul e laranja continua laranja. Só o brilho cai.
   Vai descendo até passar no contraste; o piso existe para não devolver preto
   quando a cor escolhida é quase branca. */
export function escurecerAte(hex, alvo = CONTRASTE_MINIMO) {
  const n = hex.replace("#", "");
  const rgb = [0, 1, 2].map(i => parseInt(n.slice(i * 2, i * 2 + 2), 16));
  for (let f = 0.95; f >= 0.1; f -= 0.05) {
    const escura = "#" + rgb.map(c => Math.round(c * f).toString(16).padStart(2, "0")).join("").toUpperCase();
    if (contrasteComBranco(escura) >= alvo) return escura;
  }
  return COR_PADRAO;
}

/* Devolve `{cor}` quando dá para usar, ou `{erro, sugestao}` quando não dá.
   A sugestão é a cor DELE escurecida — a recusa não custa a identidade. */
export function validarCor(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "")
    return { cor: null }; // voltar ao padrão é uma escolha válida
  const cor = normalizarHex(valor);
  if (!cor) return { erro: "Cor inválida. Use o formato #1A2B3C." };
  if (contrasteComBranco(cor) >= CONTRASTE_MINIMO) return { cor };
  return {
    erro: "Essa cor é clara demais — o texto branco do menu ficaria difícil de ler.",
    sugestao: escurecerAte(cor),
  };
}

/* O que o app precisa saber sobre a marca. Cor nula vira o padrão AQUI, num
   lugar só: se cada tela decidisse o próprio padrão, mudar o verde da barra
   um dia viraria uma caça a telas esquecidas. */
export const marcaDaOrg = (org) => ({
  logo: (org && org.logo_url) || null,
  cor: (org && org.cor_barra) || COR_PADRAO,
});
