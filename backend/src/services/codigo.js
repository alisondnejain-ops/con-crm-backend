/* O código da imobiliária.

   É a trava do cadastro e viaja dentro do link que o gestor manda para a
   equipe (`/cadastro?c=CODIGO`). Por isso precisa ser previsível, sem espaço e
   sem acento: alguém vai acabar digitando na mão, e alguém vai acabar lendo em
   voz alta no telefone.

   Vive aqui, e não dentro de uma rota, porque nasce em dois lugares: quando o
   dono cria a própria imobiliária e quando a plataforma cria uma pela mão do
   master. Dois geradores diferentes dariam dois formatos de código. */

import db from "../db.js";

export const arrumarCodigo = (v) => String(v || "").trim().toUpperCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// "Conecta Imóveis" -> "CONECTA-IMOVEIS-2026"
export const codigoSugerido = (nome) =>
  (arrumarCodigo(nome).split("-").slice(0, 2).join("-") || "IMOBILIARIA") + "-" + new Date().getFullYear();

/* Duas imobiliárias com nome parecido geram o mesmo código, e código repetido
   mandaria o corretor para a casa errada. Aqui o segundo vira -2, o terceiro
   -3, e assim por diante. */
export function codigoLivre(nome) {
  const base = codigoSugerido(nome);
  const existe = (c) => !!db.prepare("SELECT 1 FROM orgs WHERE adm_code = ?").get(c);
  if (!existe(base)) return base;
  for (let i = 2; i < 500; i++) if (!existe(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}
