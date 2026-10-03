/* PAÍSES E CÓDIGOS DE TELEFONE (03/10/2026, pedido do Ali: "acabamos de
   implementar um cliente que vende para estrangeiros, e o número do lead é
   lido automaticamente como brasileiro").

   Esta lista é a ÚNICA do sistema. O servidor a usa para montar e conferir o
   número; o build do frontend (`frontend/build.mjs`) a injeta no app como
   `PAISES_DADOS`, para o seletor de país e para escrever o número na tela.
   Duas listas — uma aqui, outra no app.jsx — iam divergir na primeira vez que
   alguém acrescentasse um país, e o país apareceria no seletor e seria
   recusado pelo servidor.

   Este arquivo NÃO importa nada: o build o lê fora do servidor.

   Cada país: código ISO, nome, código de discagem (ddi) e o tamanho do número
   NACIONAL sem o zero de longa distância (min–max). O tamanho é largo de
   propósito: serve para separar "esqueceu dígitos" de "está completo", não
   para recusar um número de verdade porque a regra do país é mais fina do que
   esta tabela.

   `zero: true` (Itália): o zero da frente FAZ PARTE do número e não pode ser
   tirado. Em todos os outros ele é o prefixo de longa distância, que não vai
   no formato internacional.

   +1 é um código só para Estados Unidos e Canadá, por isso é um item só: dois
   itens com o mesmo código fariam a tela adivinhar a bandeira. */
export const PAISES = [
  { iso: "BR", nome: "Brasil", ddi: "55", min: 10, max: 11 },
  { iso: "PT", nome: "Portugal", ddi: "351", min: 9, max: 9 },
  { iso: "US", nome: "Estados Unidos / Canadá", ddi: "1", min: 10, max: 10 },
  { iso: "AR", nome: "Argentina", ddi: "54", min: 10, max: 11 },
  { iso: "UY", nome: "Uruguai", ddi: "598", min: 8, max: 8 },
  { iso: "PY", nome: "Paraguai", ddi: "595", min: 8, max: 9 },
  { iso: "CL", nome: "Chile", ddi: "56", min: 9, max: 9 },
  { iso: "BO", nome: "Bolívia", ddi: "591", min: 8, max: 8 },
  { iso: "PE", nome: "Peru", ddi: "51", min: 8, max: 9 },
  { iso: "CO", nome: "Colômbia", ddi: "57", min: 10, max: 10 },
  { iso: "VE", nome: "Venezuela", ddi: "58", min: 10, max: 10 },
  { iso: "EC", nome: "Equador", ddi: "593", min: 8, max: 9 },
  { iso: "MX", nome: "México", ddi: "52", min: 10, max: 10 },
  { iso: "CR", nome: "Costa Rica", ddi: "506", min: 8, max: 8 },
  { iso: "PA", nome: "Panamá", ddi: "507", min: 7, max: 8 },
  { iso: "ES", nome: "Espanha", ddi: "34", min: 9, max: 9 },
  { iso: "IT", nome: "Itália", ddi: "39", min: 6, max: 11, zero: true },
  { iso: "FR", nome: "França", ddi: "33", min: 9, max: 9 },
  { iso: "DE", nome: "Alemanha", ddi: "49", min: 6, max: 12 },
  { iso: "GB", nome: "Reino Unido", ddi: "44", min: 9, max: 10 },
  { iso: "IE", nome: "Irlanda", ddi: "353", min: 7, max: 9 },
  { iso: "NL", nome: "Holanda", ddi: "31", min: 9, max: 9 },
  { iso: "BE", nome: "Bélgica", ddi: "32", min: 8, max: 9 },
  { iso: "CH", nome: "Suíça", ddi: "41", min: 9, max: 9 },
  { iso: "AT", nome: "Áustria", ddi: "43", min: 7, max: 12 },
  { iso: "LU", nome: "Luxemburgo", ddi: "352", min: 6, max: 11 },
  { iso: "SE", nome: "Suécia", ddi: "46", min: 7, max: 9 },
  { iso: "NO", nome: "Noruega", ddi: "47", min: 8, max: 8 },
  { iso: "DK", nome: "Dinamarca", ddi: "45", min: 8, max: 8 },
  { iso: "FI", nome: "Finlândia", ddi: "358", min: 6, max: 11 },
  { iso: "PL", nome: "Polônia", ddi: "48", min: 9, max: 9 },
  { iso: "CZ", nome: "República Tcheca", ddi: "420", min: 9, max: 9 },
  { iso: "GR", nome: "Grécia", ddi: "30", min: 10, max: 10 },
  { iso: "RU", nome: "Rússia", ddi: "7", min: 10, max: 10 },
  { iso: "UA", nome: "Ucrânia", ddi: "380", min: 9, max: 9 },
  { iso: "TR", nome: "Turquia", ddi: "90", min: 10, max: 10 },
  { iso: "IL", nome: "Israel", ddi: "972", min: 8, max: 9 },
  { iso: "AE", nome: "Emirados Árabes", ddi: "971", min: 8, max: 9 },
  { iso: "AO", nome: "Angola", ddi: "244", min: 9, max: 9 },
  { iso: "MZ", nome: "Moçambique", ddi: "258", min: 8, max: 9 },
  { iso: "CV", nome: "Cabo Verde", ddi: "238", min: 7, max: 7 },
  { iso: "ZA", nome: "África do Sul", ddi: "27", min: 9, max: 9 },
  { iso: "JP", nome: "Japão", ddi: "81", min: 9, max: 10 },
  { iso: "CN", nome: "China", ddi: "86", min: 9, max: 11 },
  { iso: "KR", nome: "Coreia do Sul", ddi: "82", min: 8, max: 10 },
  { iso: "IN", nome: "Índia", ddi: "91", min: 10, max: 10 },
  { iso: "AU", nome: "Austrália", ddi: "61", min: 9, max: 9 },
  { iso: "NZ", nome: "Nova Zelândia", ddi: "64", min: 8, max: 10 },
];
