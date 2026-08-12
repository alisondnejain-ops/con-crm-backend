/* O consumo da IA fica registrado com dono, e a conta bate.

   Rodar:  npm run teste:iauso
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-iauso.db");
process.env.JWT_SECRET="teste";
process.env.ANTHROPIC_API_KEY="chave-de-teste";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}

const {default:db}=await import("../src/db.js");
const {randomUUID}=await import("crypto");
const {registrar,resumoDeUso,custoDe}=await import("../src/services/iauso.js");

const org="org_"+randomUUID().slice(0,8), outra="org_"+randomUUID().slice(0,8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org,"Conecta","A-1",Date.now());
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(outra,"Vizinha","B-1",Date.now());
const user=(o,nome,role)=>{const id="u_"+randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,0,?,'ativo')`).run(id,o,nome,nome+"@x.com",role,Date.now());return id;};
const marina=user(org,"Marina","corretor"), camila=user(org,"Camila","sdr"), bruno=user(outra,"Bruno","adm");

console.log("1. A conta bate com o preço de tabela do Haiku (US$1 entrada / US$5 saída por milhão)");
const c=custoDe({entrada:985,saida:257},"claude-haiku-4-5-20251001");
console.log("   985 entrada + 257 saída = US$",c.toFixed(6));
assert.ok(Math.abs(c-0.00227)<1e-6,"esperado US$ 0,00227");

console.log("2. Cada uso fica com dono");
for(let i=0;i<4;i++) registrar({orgId:org,userId:marina,leadId:"l1",recurso:"resumo",uso:{entrada:985,saida:257}});
registrar({orgId:org,userId:camila,leadId:"l2",recurso:"resumo",uso:{entrada:2000,saida:300}});
registrar({orgId:org,userId:camila,leadId:"l2",recurso:"print_simulacao",uso:{entrada:1600,saida:120}});
registrar({orgId:outra,userId:bruno,recurso:"resumo",uso:{entrada:9999,saida:9999}});

const r=resumoDeUso(org,30);
console.log("   usos:",r.total.usos,"| gasto US$",r.total.custo);
assert.equal(r.total.usos,6,"só os desta imobiliária");
assert.equal(r.por_pessoa.length,2);
assert.equal(r.por_pessoa[0].nome,"Marina");
assert.equal(r.por_pessoa[0].usos,4);
console.log("   por pessoa:",r.por_pessoa.map(p=>`${p.nome} ${p.usos}x US$${p.custo}`).join(" | "));

console.log("3. A vizinha não aparece na conta da Conecta");
assert.ok(!JSON.stringify(r).includes("Bruno"));
assert.equal(resumoDeUso(outra,30).total.usos,1);

console.log("4. Por recurso, com rótulo em português");
console.log("   ",r.por_recurso.map(x=>`${x.rotulo}: ${x.usos}`).join(" | "));
assert.deepEqual(r.por_recurso.map(x=>x.recurso).sort(),["print_simulacao","resumo"]);

console.log("5. Uso sem tokens (chamada que falhou) não vira linha");
const antes=resumoDeUso(org,30).total.usos;
registrar({orgId:org,userId:marina,recurso:"resumo",uso:null});
assert.equal(resumoDeUso(org,30).total.usos,antes);

console.log("6. Modelo fora da tabela: tokens certos, custo zero");
assert.equal(custoDe({entrada:1000,saida:1000},"modelo-que-nao-existe"),0);
console.log("   custo de um modelo desconhecido: 0 (a tela avisa em vez de inventar preço)");

console.log("\nTudo certo ✅");
