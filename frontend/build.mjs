// Compila src/app.jsx e injeta no index.html, no lugar do último <script>.
//
// O index.html é o "molde": ele já traz o React e o ReactDOM embutidos (UMD),
// as fontes e o <style> do app. Este script NÃO mexe em nada disso — troca
// apenas o bloco de código do app pelo JSX recém-compilado. Assim o arquivo
// continua autossuficiente (um HTML só, sem rede) e pronto para o Netlify.
//
// Uso:  npm run build   (dentro de frontend/)

import { readFile, writeFile, copyFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import esbuild from "esbuild";
import { createHash } from "crypto";

const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(dir, "index.html");
const jsxPath = path.join(dir, "src", "app.jsx");

const jsx = await readFile(jsxPath, "utf8");
const html = await readFile(htmlPath, "utf8");

const out = await esbuild.transform(jsx, {
  loader: "jsx",
  format: "iife",
  target: "es2018",
  minify: true,
  // React e ReactDOM já existem como variáveis globais no index.html.
});
if (out.warnings.length) out.warnings.forEach(w => console.warn("aviso:", w.text));

/* O carimbo da build anterior sai antes de qualquer coisa: ele fica logo acima
   do bloco do app e, sem tirar, cada publicação empilharia mais um. */
const semCarimbo = html.replace(/<script>window\.CONHUB_BUILD=[^<]*<\/script>\s*/g, "");

// O código do app é sempre o ÚLTIMO <script> do arquivo.
const open = semCarimbo.lastIndexOf("<script>");
const close = semCarimbo.lastIndexOf("</script>");
if (open === -1 || close === -1 || close < open)
  throw new Error("Não encontrei o bloco <script> do app no index.html.");

/* Carimbo da versão publicada.

   Serve para o app saber que está desatualizado: ele relê o próprio index.html
   sem cache de tempos em tempos e compara este número. Quando muda, oferece
   atualizar. Sem isso a equipe fica com a versão antiga na tela e o erro
   aparece do lado do servidor, que já está novo — foi o que aconteceu com a
   Vanessa em 03/08. */
const build = new Date().toISOString().slice(0, 16).replace("T", " ") + " · " +
  createHash("sha1").update(out.code).digest("hex").slice(0, 7);

const rebuilt = semCarimbo.slice(0, open) + `<script>window.CONHUB_BUILD=${JSON.stringify(build)}</script>\n<script>\n` + out.code.trim() + "\n" + semCarimbo.slice(close);
await writeFile(htmlPath, rebuilt, "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " kB";
console.log(`index.html atualizado — app: ${kb(out.code.length)} · total: ${kb(rebuilt.length)} · build ${build}`);

/* As páginas de cadastro e de definir senha moram no backend (é ele quem tem as
   rotas), mas também precisam ser servidas pelo SITE, para o link que a gestão
   manda no grupo sair no domínio da Conecta em vez do endereço da hospedagem.

   Em vez de manter duas cópias que vão divergir, o build copia daqui. A fonte
   continua sendo backend/public — mexer lá é o certo. */
const publicas = ["cadastro.html", "definir-senha.html"];
for (const nome of publicas) {
  await copyFile(path.join(dir, "..", "backend", "public", nome), path.join(dir, nome));
  console.log(`${nome} copiado do backend`);
}
