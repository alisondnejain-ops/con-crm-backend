/* TEMPLATES DE OPERACAO — pontos de partida, nunca regra.

   Uma imobiliaria que assina o ConHub nao deveria precisar montar um funil do
   zero para comecar a usar, nem receber o funil de OUTRA imobiliaria como se
   fosse verdade universal. O template resolve os dois: entrega uma operacao
   pronta e reconhecivel no primeiro minuto, e some do caminho no momento em
   que a empresa quiser mudar qualquer coisa.

   Por isso o template e COPIADO, e nao referenciado. Depois de criado, o
   pipeline e da empresa: renomear uma etapa, mudar a ordem, ligar um SLA ou
   apagar um degrau inteiro nao mexe no template nem em nenhuma outra
   imobiliaria. Template que continua mandando depois da copia vira regra
   escondida — e regra escondida e o oposto de configuravel.

   O QUE CADA CAMPO SIGNIFICA NUMA ETAPA DE TEMPLATE

   `conversao` marca os degraus que contam como avanco comercial. Nem toda
   etapa e: "Documentacao" e trabalho administrativo necessario, e conta-la
   como conversao faz o relatorio dizer que a operacao converteu quando ela so
   juntou papel. E a separacao entre funil de conversao e avanco operacional,
   decidida aqui e nao na hora de desenhar o grafico.

   `sla` e o tempo maximo SEM INTERACAO que aquela etapa tolera, em minutos.
   Os numeros abaixo sao chute honesto de operacao imobiliaria — primeiro
   contato em uma hora, qualificacao em um dia, documentacao em tres. Servem
   para o sistema nascer avisando alguma coisa em vez de nascer mudo; a empresa
   ajusta para a realidade dela.

   `tipo` diz se a etapa e desfecho (ganho/perdido) sem depender do NOME. Uma
   imobiliaria pode chamar a venda de "Fechado", outra de "Assinado" — o
   relatorio nao pode ficar procurando a palavra "Venda". */

export const TEMPLATES = [
  {
    id: "sdr",
    nome: "SDR / Pré-atendimento",
    tipo: "sdr",
    descricao: "Primeiro contato e qualificação, antes de o lead ir para um corretor.",
    para: "Operações com atendente dedicado que filtra e distribui.",
    etapas: [
      { name: "Lead novo", color: "#6B7280", sla: 30, aviso: 10 },
      { name: "Primeiro contato", color: "#0E8F6E", sla: 60, aviso: 20, conversao: true },
      { name: "Tentativa 2", color: "#D97706", sla: 240 },
      { name: "Tentativa 3", color: "#D97706", sla: 480 },
      { name: "Em qualificação", color: "#2563EB", sla: 720, conversao: true },
      { name: "Lead qualificado", color: "#0A3D30", conversao: true, tipo: "ganho" },
    ],
  },
  {
    id: "comercial",
    nome: "Comercial imobiliário",
    tipo: "commercial",
    descricao: "Do lead recebido até a venda, com curadoria, visita e negociação.",
    para: "Venda de imóvel pronto ou na planta.",
    etapas: [
      { name: "Lead recebido", color: "#6B7280", sla: 30, aviso: 10 },
      { name: "Atendimento qualificado", color: "#0E8F6E", sla: 1440, conversao: true },
      { name: "Curadoria / Produto de interesse", color: "#2563EB", sla: 2880, conversao: true },
      // Administrativa: precisa acontecer, mas não é degrau de venda.
      { name: "Documentação / Dados comerciais", color: "#7C3AED", sla: 4320 },
      { name: "Agendamento", color: "#D97706", sla: 1440, conversao: true },
      { name: "Visita", color: "#D97706", sla: 2880, conversao: true },
      { name: "Proposta", color: "#DB2777", sla: 2880, conversao: true },
      { name: "Negociação", color: "#DB2777", sla: 4320, conversao: true },
      { name: "Venda", color: "#0A3D30", conversao: true, tipo: "ganho" },
      { name: "Perdido", color: "#E1553A", tipo: "perdido" },
    ],
  },
  {
    id: "recaptacao",
    nome: "Recaptação",
    tipo: "recapture",
    descricao: "Retomada de lead antigo que esfriou ou não respondeu.",
    para: "Trabalhar a base parada sem misturar com o atendimento novo.",
    etapas: [
      { name: "Lead", color: "#6B7280" },
      { name: "Tentativa de contato", color: "#D97706", sla: 2880 },
      { name: "Respondeu", color: "#0E8F6E", sla: 1440, conversao: true },
      { name: "Interesse futuro", color: "#2563EB", conversao: true },
      { name: "Reativado", color: "#0A3D30", conversao: true, tipo: "ganho" },
      { name: "Sem interesse", color: "#9CA3AF", tipo: "perdido" },
      { name: "Perdido", color: "#E1553A", tipo: "perdido" },
    ],
  },
  {
    id: "locacao",
    nome: "Locação",
    tipo: "rental",
    descricao: "Da procura ao contrato assinado, com análise de garantia.",
    para: "Operação de aluguel, que tem análise e documentação próprias.",
    etapas: [
      { name: "Lead novo", color: "#6B7280", sla: 30, aviso: 10 },
      { name: "Qualificado", color: "#0E8F6E", sla: 1440, conversao: true },
      { name: "Visita", color: "#D97706", sla: 2880, conversao: true },
      { name: "Documentação", color: "#7C3AED", sla: 4320 },
      { name: "Análise", color: "#7C3AED", sla: 4320 },
      { name: "Contrato", color: "#DB2777", sla: 2880, conversao: true },
      { name: "Locado", color: "#0A3D30", conversao: true, tipo: "ganho" },
      { name: "Perdido", color: "#E1553A", tipo: "perdido" },
    ],
  },
];

export const templatePorId = (id) => TEMPLATES.find(t => t.id === id) || null;

/* O funil que as imobiliarias JA usavam, virado template.

   Ate 28/08/2026 estas eram as unicas etapas que existiam, escritas no codigo
   (services/stages.js). Elas viram o pipeline padrao de toda conta que ja
   existe, e e isso que faz a mudanca ser invisivel para quem esta operando:
   quem abre o CRM amanha ve exatamente o mesmo funil, agora editavel.

   NAO e o template oferecido a cliente novo — para esse, o "Comercial
   imobiliario" acima descreve melhor uma operacao de venda. Este existe para
   preservar o que ja esta em uso. */
export const FUNIL_ATUAL = {
  nome: "Comercial",
  tipo: "commercial",
  descricao: "O funil que a equipe já usava, agora configurável.",
  etapas: [
    { name: "Lead", color: "#6B7280" },
    { name: "Atendimento", color: "#0E8F6E", conversao: true },
    { name: "Pasta", color: "#7C3AED" },
    { name: "Aprovação", color: "#2563EB", conversao: true },
    { name: "Agendamento", color: "#D97706", conversao: true },
    { name: "Visita", color: "#D97706", conversao: true },
    { name: "Proposta", color: "#DB2777", conversao: true },
    { name: "Venda", color: "#0A3D30", conversao: true, tipo: "ganho" },
    { name: "Perdido", color: "#E1553A", tipo: "perdido" },
    { name: "Recaptação", color: "#9CA3AF" },
    { name: "Transferido por ligação", color: "#9CA3AF" },
  ],
};
