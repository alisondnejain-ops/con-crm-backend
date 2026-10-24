/* As fotos dos imóveis passando pelo tratamento automático (`services/fotos.js`)
   na hora de guardar. Separado de fotos.js de propósito: aquele só mexe em
   imagem e não sabe de banco nem de armazenamento; este junta os dois. */
import db from "../db.js";
import { salvar, apagar, bytesDoArquivo, bytesParaBaixar } from "./storage.js";
import { tratarFoto } from "./fotos.js";

/* Trata e guarda uma foto nova. Devolve o que vai para a linha de
   `produto_midias`. Se a imagem não abrir na biblioteca, guarda o arquivo como
   veio (como era antes do tratamento) e anota o motivo: foto que não pôde ser
   tratada não pode impedir o corretor de cadastrar o imóvel. */
export async function guardarFotoTratada({ buffer, mime, prefixo }) {
  let t;
  try { t = await tratarFoto(buffer); }
  catch (e) {
    const { url, chave } = await salvar({ buffer, mime, prefixo });
    return { url, chave, campos: { tratada_em: Date.now(), tratamento_erro: String(e.message || e).slice(0, 300) } };
  }
  return gravarTratamento(t, prefixo);
}

async function gravarTratamento(t, prefixo) {
  const gravados = [];
  try {
    const original = await salvar({ buffer: t.original, mime: "image/jpeg", prefixo });
    gravados.push(original.chave);
    const variantes = [];
    for (const v of t.variantes) {
      const s = await salvar({ buffer: v.buffer, mime: "image/webp", prefixo: `${prefixo}/v` });
      gravados.push(s.chave);
      variantes.push({ l: v.largura, url: s.url, chave: s.chave });
    }
    return {
      url: original.url, chave: original.chave,
      campos: {
        variantes: JSON.stringify(variantes), largura: t.largura, altura: t.altura,
        foco_x: t.foco_x, foco_y: t.foco_y, avisos: JSON.stringify(t.avisos), nota: t.nota,
        tratada_em: Date.now(), tratamento_erro: null,
      },
    };
  } catch (e) {
    // Gravou a metade: apaga o que subiu, para não sobrar arquivo sem dono.
    for (const c of gravados) await apagar(c);
    throw e;
  }
}

/* Todos os arquivos de uma foto: o principal e as versões. É o que precisa
   sair quando a foto, o imóvel ou a conta são apagados. */
export function chavesDaMidia(m) {
  const chaves = m.chave ? [m.chave] : [];
  try { for (const v of JSON.parse(m.variantes || "[]")) if (v.chave) chaves.push(v.chave); } catch {}
  return chaves;
}

export async function apagarArquivosDaMidia(m) {
  for (const c of chavesDaMidia(m)) await apagar(c);
}

/* AS FOTOS QUE JÁ EXISTIAM. Um batimento trata algumas por vez, das mais
   novas para as mais antigas (imóvel recente é o que está sendo divulgado), e
   troca o arquivo da linha pelo limpo — o que tira a localização do celular
   das fotos que já estavam no site e nos portais. O arquivo antigo é apagado:
   nenhuma outra tabela guarda o endereço de foto de imóvel (o envio pelo
   WhatsApp registra só o texto "[Imóvel enviado]").

   Uma por vez e poucas por rodada: cada foto leva de meio a um segundo de
   processamento, e o servidor atende a equipe e os webhooks ao mesmo tempo.
   Falhou, anota o motivo e não tenta de novo — senão uma foto corrompida
   seria reprocessada a cada batimento para sempre. */
let rodando = false;
export async function tratarFotosPendentes(limite = 3) {
  if (rodando) return { tratadas: 0, falhas: 0 };
  rodando = true;
  let tratadas = 0, falhas = 0;
  try {
    const linhas = db.prepare(`SELECT m.*, p.id AS pid FROM produto_midias m JOIN produtos p ON p.id = m.produto_id
      WHERE m.tipo = 'foto' AND m.tratada_em IS NULL ORDER BY m.created_at DESC LIMIT ?`).all(limite);
    for (const m of linhas) {
      try {
        const buffer = m.chave ? await bytesDoArquivo(m.chave).catch(() => bytesParaBaixar(m.url)) : await bytesParaBaixar(m.url);
        let t;
        try { t = await tratarFoto(buffer); }
        catch (e) {
          db.prepare("UPDATE produto_midias SET tratada_em = ?, tratamento_erro = ? WHERE id = ?")
            .run(Date.now(), String(e.message || e).slice(0, 300), m.id);
          falhas++; continue;
        }
        const novo = await gravarTratamento(t, `produtos/${m.pid}`);
        // A foto pode ter sido apagada enquanto era tratada: confere antes de trocar.
        const info = db.prepare(`UPDATE produto_midias SET url=@url, chave=@chave, variantes=@variantes, largura=@largura,
          altura=@altura, foco_x=@foco_x, foco_y=@foco_y, avisos=@avisos, nota=@nota, tratada_em=@tratada_em,
          tratamento_erro=@tratamento_erro WHERE id=@id AND tratada_em IS NULL`).run({ id: m.id, url: novo.url, chave: novo.chave, ...novo.campos });
        if (info.changes) { if (m.chave) await apagar(m.chave); tratadas++; }
        else await apagarArquivosDaMidia({ chave: novo.chave, variantes: novo.campos.variantes });
      } catch (e) {
        // Não conseguiu ler o arquivo de jeito nenhum (sumiu do armazenamento).
        db.prepare("UPDATE produto_midias SET tratada_em = ?, tratamento_erro = ? WHERE id = ?")
          .run(Date.now(), "não consegui ler o arquivo: " + String(e.message || e).slice(0, 250), m.id);
        falhas++;
      }
    }
  } finally { rodando = false; }
  return { tratadas, falhas };
}

export function fotosPendentes() {
  return db.prepare("SELECT COUNT(*) n FROM produto_midias WHERE tipo = 'foto' AND tratada_em IS NULL").get().n;
}
