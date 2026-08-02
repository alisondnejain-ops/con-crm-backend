/* Fuso horário da operação.

   A hospedagem roda em UTC. Petrolina/Juazeiro é UTC-3, então sem isto o
   servidor entende "30/07" como começando às 21h do dia 29 no horário daqui —
   e todo relatório por período nasce com três horas de lead no dia errado.

   Precisa rodar ANTES de qualquer outro módulo tocar em datas, por isso é um
   arquivo só para isso, importado no topo do server.js. Dá para sobrepor pela
   variável TZ na hospedagem, se um dia a imobiliária abrir em outro estado. */
process.env.TZ = process.env.TZ || "America/Recife";
