/* A FICHA DO IMÓVEL, PARA QUALQUER ESTADO (25/11/2026, pedido do Ali: "a
   ficha de cadastro está atualizada apenas para Pernambuco, porque foi a
   Conecta quem começou tudo — o Morar Bem só existe em Pernambuco").

   Esta lista é a ÚNICA do sistema, como a de países: o servidor a usa para
   conferir o que chega, e o build do frontend (`frontend/build.mjs`) a injeta
   no app como `FICHA_IMOVEL`. Duas cópias divergiriam na primeira opção
   acrescentada — a caixa apareceria na tela e o servidor jogaria a marcação
   fora em silêncio.

   Este arquivo NÃO importa nada: o build o lê fora do servidor.

   O que é DE ONDE:
   - PAGAMENTOS: condições nacionais. O programa de um estado ou de uma
     cidade (Morar Bem PE, Casa Paulista…) é texto livre (`programa_local`),
     porque não existe lista que cubra todos.
   - GARANTIAS: só de aluguel.
   - CARACTERISTICAS: o que o visitante e o cliente podem ler. Vão para o
     site e para a mensagem do imóvel.
   - DETALHES: escolhas de uma opção só. `interno: true` nunca sai para fora
     (site, portal, mensagem ao cliente, IA que fala com o cliente). */

export const PAGAMENTOS = [
  { v: "financiamento", t: "Financiamento bancário" },
  { v: "mcmv", t: "Minha Casa Minha Vida" },
  { v: "fgts", t: "Aceita FGTS", c: "FGTS" },
  { v: "direto", t: "Parcelamento direto" },
  { v: "consorcio", t: "Carta de consórcio" },
  { v: "permuta", t: "Aceita permuta" },
  { v: "veiculo", t: "Aceita veículo na negociação" },
];

export const GARANTIAS = [
  { v: "caucao", t: "Caução" },
  { v: "fiador", t: "Fiador" },
  { v: "seguro_fianca", t: "Seguro-fiança" },
  { v: "capitalizacao", t: "Título de capitalização" },
  { v: "garantia_digital", t: "Garantia digital (sem fiador)" },
];

/* `para`: em que tipos de cadastro o grupo aparece na tela. Terreno não tem
   "varanda gourmet", e casa pronta raramente precisa de "asfalto" — mas o
   servidor aceita qualquer chave da lista em qualquer tipo: esconder é só para
   a tela não virar um formulário de imposto. */
const TODOS = ["empreendimento", "loteamento", "terreno", "pronto", "casa", "apartamento", "comercial", "rural"];
const CONSTRUIDO = ["empreendimento", "pronto", "casa", "apartamento", "comercial", "rural"];
export const CARACTERISTICAS = [
  { grupo: "ambientes", titulo: "Ambientes", para: CONSTRUIDO, itens: [
    { v: "varanda", t: "Varanda" }, { v: "varanda_gourmet", t: "Varanda gourmet" }, { v: "sacada", t: "Sacada" },
    { v: "cozinha_americana", t: "Cozinha americana" }, { v: "area_servico", t: "Área de serviço" },
    { v: "escritorio", t: "Escritório" }, { v: "closet", t: "Closet" }, { v: "despensa", t: "Despensa" },
    { v: "quintal", t: "Quintal" }, { v: "jardim", t: "Jardim" }, { v: "terraco", t: "Terraço" },
    { v: "edicula", t: "Edícula" }, { v: "dependencia", t: "Dependência de serviço" },
    { v: "piscina_privativa", t: "Piscina privativa" }, { v: "churrasqueira_privativa", t: "Churrasqueira privativa" },
  ] },
  { grupo: "conforto", titulo: "Acabamento e conforto", para: CONSTRUIDO, itens: [
    { v: "ar_condicionado", t: "Ar-condicionado" }, { v: "infra_ar", t: "Infraestrutura para ar-condicionado" },
    { v: "armarios", t: "Armários planejados" }, { v: "aquecedor_gas", t: "Aquecimento a gás" },
    { v: "aquecedor_solar", t: "Aquecimento solar" }, { v: "energia_solar", t: "Energia solar" },
    { v: "porcelanato", t: "Piso porcelanato" }, { v: "piso_madeira", t: "Piso de madeira ou laminado" },
    { v: "gesso", t: "Forro de gesso" }, { v: "pe_direito_alto", t: "Pé-direito alto" },
    { v: "medidor_agua", t: "Medidor de água individual" }, { v: "gas_encanado", t: "Gás encanado" },
    { v: "fibra", t: "Internet por fibra" }, { v: "vista_livre", t: "Vista livre" }, { v: "vista_mar", t: "Vista para o mar" },
  ] },
  { grupo: "lazer", titulo: "Lazer e condomínio", para: ["empreendimento", "loteamento", "pronto", "casa", "apartamento", "comercial"], itens: [
    { v: "piscina", t: "Piscina" }, { v: "academia", t: "Academia" }, { v: "salao_festas", t: "Salão de festas" },
    { v: "espaco_gourmet", t: "Espaço gourmet" }, { v: "churrasqueira", t: "Churrasqueira" }, { v: "playground", t: "Playground" },
    { v: "brinquedoteca", t: "Brinquedoteca" }, { v: "quadra", t: "Quadra poliesportiva" }, { v: "beach_tennis", t: "Quadra de areia / beach tennis" },
    { v: "sauna", t: "Sauna" }, { v: "espaco_pet", t: "Espaço pet" }, { v: "coworking", t: "Coworking" },
    { v: "bicicletario", t: "Bicicletário" }, { v: "elevador", t: "Elevador" }, { v: "gerador", t: "Gerador" },
    { v: "area_verde", t: "Área verde" },
  ] },
  { grupo: "seguranca", titulo: "Segurança", para: TODOS, itens: [
    { v: "portaria_24h", t: "Portaria 24h" }, { v: "seguranca_24h", t: "Segurança 24h" }, { v: "cameras", t: "Câmeras" },
    { v: "cerca_eletrica", t: "Cerca elétrica" }, { v: "alarme", t: "Alarme" }, { v: "portao_eletronico", t: "Portão eletrônico" },
    { v: "condominio_fechado", t: "Condomínio fechado" }, { v: "interfone", t: "Interfone" },
  ] },
  { grupo: "infra", titulo: "Infraestrutura", para: ["loteamento", "terreno", "rural", "casa"], itens: [
    { v: "agua", t: "Água encanada" }, { v: "energia", t: "Energia elétrica" }, { v: "esgoto", t: "Rede de esgoto" },
    { v: "gas_natural", t: "Gás natural" }, { v: "asfalto", t: "Rua asfaltada" }, { v: "iluminacao", t: "Iluminação pública" },
    { v: "murado", t: "Murado" }, { v: "poco", t: "Poço artesiano" },
  ] },
];

export const DETALHES = {
  ocupacao: { t: "Ocupação", opcoes: { desocupado: "Desocupado", proprietario: "Ocupado pelo proprietário", locado: "Alugado (com inquilino)" } },
  mobilia: { t: "Mobília", opcoes: { sem: "Sem móveis", semi: "Semimobiliado", mobiliado: "Mobiliado" } },
  posicao: { t: "Posição", opcoes: { frente: "Frente", fundos: "Fundos", lateral: "Lateral", meio: "Meio de quadra", esquina: "Esquina" } },
  sol: { t: "Sol", opcoes: { manha: "Sol da manhã (nascente)", tarde: "Sol da tarde (poente)", ambos: "Sol da manhã e da tarde" } },
  garagem: { t: "Garagem", opcoes: { coberta: "Coberta", descoberta: "Descoberta", ambas: "Coberta e descoberta", rotativa: "Rotativa / coletiva" } },
  // Interno: diz à equipe se o imóvel aceita financiamento sem surpresa no cartório.
  documentacao: { t: "Documentação", interno: true, opcoes: {
    registrado: "Escritura e registro em dia", escritura: "Escritura sem registro", contrato: "Contrato de compra e venda",
    inventario: "Em inventário", financiado: "Com financiamento a quitar", regularizacao: "Em regularização" } },
};

export const IPTU_PERIODOS = { anual: "por ano", mensal: "por mês" };

const rotulos = (lista) => Object.fromEntries(lista.map(x => [x.v, x.t]));
export const ROTULO_PAGAMENTO = rotulos(PAGAMENTOS);
// Na frase "Aceita: …" o rótulo curto, para não escrever "Aceita: …, Aceita FGTS".
export const ROTULO_PAGAMENTO_CURTO = Object.fromEntries(PAGAMENTOS.map(x => [x.v, x.c || x.t]));
export const ROTULO_GARANTIA = rotulos(GARANTIAS);
export const ROTULO_CARACTERISTICA = rotulos(CARACTERISTICAS.flatMap(g => g.itens));

export const FICHA_IMOVEL = { PAGAMENTOS, GARANTIAS, CARACTERISTICAS, DETALHES, IPTU_PERIODOS };
