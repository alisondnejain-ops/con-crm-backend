/* O resumo da conversa, sem gastar com a IA de verdade.

   O que este teste guarda: resposta de modelo é texto, e texto vem torto —
   embrulhado em ```json, com campo faltando, com campo inventado, ou não
   sendo JSON coisa nenhuma. Nada disso pode virar tela quebrada nem, pior,
   informação inventada com cara de certeza na ficha do lead.

   A chamada HTTP é substituída aqui dentro; nenhum centavo é gasto.

   Rodar:  npm run teste:resumo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-resumo.db");
process.env.JWT_SECRET="teste";
process.env.ANTHROPIC_API_KEY="chave-de-teste";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}

const {resumirConversa,iaConfigurada}=await import("../src/services/ia.js");
assert.equal(iaConfigurada(),true);

// Troca a chamada HTTP: devolvemos o que quisermos no lugar do modelo.
const real=globalThis.fetch;
let ultimoPedido=null;
const responder=(texto)=>{ globalThis.fetch=async(url,opcoes)=>{
  ultimoPedido=JSON.parse(opcoes.body);
  return { ok:true, status:200, json:async()=>({content:[{type:"text",text:texto}],usage:{input_tokens:900,output_tokens:180}}) };
};};

const conversa=[
  {de:"cliente",texto:"Oi, vi o anúncio do apartamento no Areia Branca"},
  {de:"imobiliaria",texto:"Oi João! Vou dar continuidade ao seu atendimento."},
  {de:"cliente",texto:"Tenho 3 mil de renda e 15 mil de entrada, quero 2 quartos"},
  {de:"imobiliaria",texto:"Perfeito, consigo te agendar uma visita sábado"},
  {de:"cliente",texto:"Pode ser sábado de manhã"},
];

console.log("1. Resposta boa vira ficha organizada");
responder(JSON.stringify({
  situacao:"Cliente interessado em apartamento no Areia Branca, visita combinada.",
  quer:"Apartamento de 2 quartos no Areia Branca",
  pode_pagar:"Renda de R$ 3.000 e entrada de R$ 15.000",
  combinado:"Visita no sábado de manhã",
  proximo_passo:"Confirmar o horário da visita de sábado",
  faltando:["Se tem restrição no CPF","Se é o primeiro imóvel","Prazo para mudar","FGTS disponível","campo a mais"],
  atencao:null,
}));
let r=await resumirConversa({mensagens:conversa,nome:"João"});
assert.ok(r.ok,r.erro);
assert.equal(r.resumo.quer,"Apartamento de 2 quartos no Areia Branca");
assert.equal(r.resumo.faltando.length,4,"no máximo 4 perguntas — lista longa ninguém lê");
assert.equal(r.resumo.atencao,null);
assert.equal(r.resumo.mensagens_lidas,5);
assert.deepEqual(r.uso,{entrada:900,saida:180});
console.log("   próximo passo:",r.resumo.proximo_passo);

console.log("2. A conversa vai no pedido, marcando quem falou o quê");
assert.match(ultimoPedido.messages[0].content[0].text,/CLIENTE: Oi, vi o anúncio/);
assert.match(ultimoPedido.messages[0].content[0].text,/IMOBILIÁRIA: Oi João!/);

console.log("3. JSON embrulhado em cercas de código ainda é lido");
responder("```json\n"+JSON.stringify({situacao:"Tudo certo",proximo_passo:"Ligar"})+"\n```");
r=await resumirConversa({mensagens:conversa,nome:"João"});
assert.ok(r.ok); assert.equal(r.resumo.situacao,"Tudo certo");
assert.equal(r.resumo.quer,null,"campo ausente vira null, não 'undefined' na tela");

console.log("4. Resposta que não é JSON não quebra nada");
responder("Claro! Aqui vai o resumo: o cliente quer um apartamento...");
r=await resumirConversa({mensagens:conversa,nome:"João"});
assert.equal(r.ok,false);
console.log("   ",r.erro);

console.log("5. Conversa curta não é mandada para a IA");
ultimoPedido=null;
r=await resumirConversa({mensagens:[{de:"cliente",texto:"oi"}],nome:"João"});
assert.equal(r.ok,false);
assert.equal(ultimoPedido,null,"não pode nem chamar a API");
console.log("   ",r.erro);

console.log("6. Erro da API vira recado em português, sem derrubar nada");
globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:"invalid x-api-key"}})});
r=await resumirConversa({mensagens:conversa,nome:"João"});
assert.equal(r.ok,false);
assert.match(r.erro,/Chave da IA inválida/);
console.log("   ",r.erro);

globalThis.fetch=real;
console.log("\nTudo certo ✅");
