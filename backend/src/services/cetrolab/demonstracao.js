/* PRÉVIA DE MODELO COM IMÓVEIS DE EXEMPLO (23/11/2026, pedido do Ali: "gera
   uma prévia pra mim com o domínio do ConHub, que vou verificar").

   A Chiabai Imóveis acabou de entrar e ainda não mandou os imóveis — e um
   modelo de site não se avalia com a vitrine vazia. Esta prévia desenha o
   modelo com os imóveis que estão no site PÚBLICO deles hoje (título, preço,
   área, cômodos, descrição do anúncio e o endereço das fotos), guardados em
   demonstracao-chiabai.json. Nada vem do banco: é uma `fonte` em memória, a
   mesma porta que os modelos usam para ler o catálogo (services/cetrolab/fonte.js).

   As travas: noindex em toda página; uma faixa no alto diz que é prévia; o
   WhatsApp não abre (não manda mensagem para ninguém); e não há formulário
   nenhum. As fotos são carregadas pelo navegador direto do endereço público
   onde já estão — o servidor não baixa nem guarda nada. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { filtrosDe as filtrosReais, slugify } from "../site.js";

const POR_PAGINA = 24;
const DIR = path.dirname(fileURLToPath(import.meta.url));

function publicoDemo(x) {
  const casa = x.categoria !== "terreno";
  return {
    id: x.id, codigo: x.codigo, titulo: x.titulo, finalidade: x.finalidade || "venda",
    tipo: casa ? "casa" : "terreno", categoria: x.categoria, empreendimento: !!x.lanc,
    valor: x.valor || null, condominio: null, iptu: null,
    quartos: x.quartos || null, suites: x.suites || null, banheiros: x.banheiros || null, vagas: x.vagas || null,
    area_util: x.area || null, terreno: null, descricao: x.descricao || null, modalidade: null, moeda: "BRL", unidades: [],
    local: { linha: [x.bairro, [x.cidade, x.uf].filter(Boolean).join(" - ")].filter(Boolean).join(" · "), curta: [x.bairro, x.cidade].filter(Boolean).join(" · ") },
    lugar: { bairro: x.bairro, cidade: x.cidade, uf: x.uf }, fotos: x.fotos || [], video: null,
  };
}

function fonteDe(lista, conteudo) {
  const itens = lista.map(publicoDemo);
  const passa = (i, f) => (!f.finalidade || i.finalidade === f.finalidade) && (!f.tipo || i.tipo === f.tipo)
    && (!f.cidade || i.lugar.cidade === f.cidade) && (!f.bairro || i.lugar.bairro === f.bairro)
    && (!f.quartos || (i.quartos || 0) >= f.quartos) && (!f.ate || (i.valor && i.valor <= f.ate))
    && (!f.codigo || i.codigo === f.codigo) && (!f.lancamentos || i.empreendimento);
  return {
    filtrosDe: filtrosReais,
    catalogo(orgId, f) {
      const achados = itens.filter(i => passa(i, f));
      const p = f.p || 1;
      return { total: achados.length, itens: achados.slice((p - 1) * POR_PAGINA, p * POR_PAGINA),
        cidades: [...new Set(itens.map(i => i.lugar.cidade).filter(Boolean))].sort(),
        disponiveis: itens.length, paginas: Math.max(1, Math.ceil(achados.length / POR_PAGINA)) };
    },
    bairrosDoCatalogo() {
      const m = new Map();
      for (const i of itens) {
        const b = i.lugar.bairro; if (!b) continue;
        const r = m.get(b) || { bairro: b, cidade: i.lugar.cidade, total: 0, venda_desde: null, aluguel_desde: null };
        r.total++;
        if (i.valor && i.finalidade === "venda") r.venda_desde = r.venda_desde == null ? i.valor : Math.min(r.venda_desde, i.valor);
        m.set(b, r);
      }
      return [...m.values()].sort((a, b) => b.total - a.total || a.bairro.localeCompare(b.bairro, "pt-BR"));
    },
    resumoDoCatalogo() {
      const vendas = itens.filter(i => i.valor && i.finalidade === "venda").map(i => i.valor);
      return { total: itens.length, bairros: new Set(itens.map(i => i.lugar.bairro).filter(Boolean)).size,
        venda_desde: vendas.length ? Math.min(...vendas) : null, aluguel_desde: null };
    },
    conteudoPublico: () => conteudo,
    imovel: (id) => itens.find(i => i.id === id) || null,
  };
}

/* As prévias que existem. Uma por cliente que ainda não mandou os imóveis. */
const PREVIAS = {
  chiabai: {
    modelo: "prime",
    nome: "Chiabai Imóveis",
    cor: "#B0322B",
    logo: null,
    arquivo: "demonstracao-chiabai.json",
    frase: "Encontre o imóvel perfeito dos seus sonhos",
    conteudo: {
      sobre: "A Chiabai Imóveis iniciou suas atividades em 2013 para construir a sua história no mercado imobiliário do Espírito Santo de forma sólida, confiável e duradoura.\n\nÉtica profissional e transparência são imprescindíveis no mercado imobiliário. Por isso, cada cliente recebe um atendimento personalizado, que traz segurança a todos os negócios realizados.",
      redes: { instagram: "https://www.instagram.com/imobiliariachiabai/", facebook: "https://www.facebook.com/chiabaiimoveis/", youtube: null },
      equipe: [], depoimentos: [],
    },
  },
};
const CACHE = new Map();

/* Monta o contexto que o modelo recebe, no mesmo formato do site de verdade. */
export function contextoDaPrevia(nome, base) {
  const p = PREVIAS[nome];
  if (!p) return null;
  if (!CACHE.has(nome)) CACHE.set(nome, JSON.parse(fs.readFileSync(path.join(DIR, p.arquivo), "utf8")));
  const fonte = fonteDe(CACHE.get(nome), p.conteudo);
  return {
    modelo: p.modelo, fonte,
    demo: `PRÉVIA DO MODELO ${p.modelo.toUpperCase()} — imóveis de exemplo tirados do site atual da ${p.nome}. Não é o site no ar.`,
    cfg: { org_id: "previa-" + nome, whatsapp: "", frase: p.frase, pixel_id: null, gtm_id: null, modelo: p.modelo },
    org: { id: "previa-" + nome, name: p.nome },
    marca: { cor: p.cor, logo: p.logo },
    base, raiz: `/cetrolab/previa/${nome}`,
  };
}
export { slugify };
